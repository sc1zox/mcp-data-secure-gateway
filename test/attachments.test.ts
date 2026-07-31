import { strict as assert } from 'node:assert';
import { readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { describe, it } from 'node:test';
import { AttachmentOptimizationPipeline, STAGES } from '../src/attachments/pipeline.js';
import { PdfOptimizer } from '../src/attachments/pdfOptimizer.js';
import { ProcessRunner, ProcessTimeoutError, withWorkspace } from '../src/attachments/processRunner.js';
import { buildTransformPolicy, POLICY_VERSION } from '../src/attachments/profiles.js';
import type {
    Candidate,
    FormatOptimizer,
    FormatSignature,
    OptimizationContext,
    OptimizationInput,
    OptimizationLimits,
    PreflightVerdict,
    ToolAvailability
} from '../src/attachments/types.js';
import { JPEG_MIME, PDF_MIME, OptimizationTimeoutError } from '../src/attachments/types.js';
import type { ApprovedTransformPolicy, TransformProfile } from '../src/core/types.js';
import { sha256Bytes } from '../src/util/hash.js';

/**
 * Acceptance criteria of US-001.
 *
 * The pipeline suites drive doubles rather than qpdf and Ghostscript: the
 * Definition of Done asks for unit tests that pass without those binaries
 * installed, and the ordering and budget rules are the part worth pinning
 * precisely anyway. The real tool chain is exercised separately at the bottom
 * of this file, and skips itself where a binary is missing.
 */

const LIMITS: OptimizationLimits = {
    maxSingleInputBytes: 50 * 1024 * 1024,
    maxTotalInputBytes: 100 * 1024 * 1024,
    maxWorkingBytes: 300 * 1024 * 1024,
    timeBudgetMs: 30_000
};

function policy(
    maxProfile: TransformProfile = 'compact',
    formats: string[] = [PDF_MIME, JPEG_MIME]
): ApprovedTransformPolicy {
    return { policyVersion: 'test', maxProfile, formats: [...formats].sort() };
}

function file(name: string, mimeType: string, size: number, fill = 7): OptimizationInput {
    const bytes = new Uint8Array(size).fill(fill);
    return { filename: name, mimeType, bytes, sha256: sha256Bytes(bytes) };
}

interface FakeBehaviour {
    available?: boolean;
    /** Output size as a fraction of the original, per rung. */
    factor?: Partial<Record<TransformProfile, number>>;
    /** Rungs that produce nothing valid. */
    fail?: TransformProfile[];
    /** Rungs that throw the given error. */
    throwOn?: Partial<Record<TransformProfile, Error>>;
    /** Filenames the preflight refuses to transform. */
    refuse?: string[];
    /** Absolute output size, overriding `factor`. */
    absolute?: Partial<Record<TransformProfile, number>>;
}

/** Records every call, so the ordering criteria can be asserted directly. */
class FakeOptimizer implements FormatOptimizer {
    readonly optimizer: string;
    /** `${filename}@${profile}`, in the order `produce` was called. */
    readonly produced: string[] = [];
    readonly preflighted: string[] = [];
    /** The bytes `produce` was handed, per call — proves no cascading. */
    readonly seenInputs: Uint8Array[] = [];

    constructor(
        readonly mimeType: string,
        readonly profiles: readonly TransformProfile[],
        private readonly behaviour: FakeBehaviour = {}
    ) {
        this.optimizer = `fake-${mimeType}`;
    }

    async available(): Promise<ToolAvailability> {
        return this.behaviour.available === false
            ? { available: false, version: '', detail: 'Testwerkzeug fehlt.' }
            : { available: true, version: `${this.optimizer} 1.0` };
    }

    async preflight(input: OptimizationInput): Promise<PreflightVerdict> {
        this.preflighted.push(input.filename);
        if (this.behaviour.available === false) {
            return { transformable: true };
        }
        if (this.behaviour.refuse?.includes(input.filename)) {
            return { transformable: false, reason: 'test_refused' };
        }
        return { transformable: true, signature: { pages: 3 } };
    }

    async produce(
        input: OptimizationInput,
        profile: TransformProfile,
        _signature: FormatSignature | undefined,
        _ctx: OptimizationContext
    ): Promise<Candidate | undefined> {
        this.produced.push(`${input.filename}@${profile}`);
        this.seenInputs.push(input.bytes);
        const thrown = this.behaviour.throwOn?.[profile];
        if (thrown) {
            throw thrown;
        }
        if (this.behaviour.fail?.includes(profile)) {
            return undefined;
        }
        const absolute = this.behaviour.absolute?.[profile];
        const size =
            absolute ?? Math.round(input.bytes.byteLength * (this.behaviour.factor?.[profile] ?? 0.5));
        return {
            bytes: new Uint8Array(Math.max(size, 1)).fill(1),
            profile,
            optimizer: this.optimizer,
            toolVersion: `${this.optimizer} 1.0`,
            durationMs: 1
        };
    }
}

const pdfLadder: readonly TransformProfile[] = ['structural', 'balanced', 'compact'];
const jpegLadder: readonly TransformProfile[] = ['balanced', 'compact'];

describe('US-001 Pipeline: Budget und No-op', () => {
    it('AK-1: ruft keinen Optimierer auf, wenn die Summe bereits passt', async () => {
        const pdf = new FakeOptimizer(PDF_MIME, pdfLadder);
        const pipeline = new AttachmentOptimizationPipeline([pdf]);
        const input = file('a.pdf', PDF_MIME, 1000);

        const result = await pipeline.run([input], 5000, policy(), LIMITS);

        assert.ok(result.ok);
        assert.equal(result.optimised, false);
        assert.equal(pdf.produced.length, 0);
        assert.equal(pdf.preflighted.length, 0);
        assert.deepEqual(result.attachments[0]!.bytes, input.bytes);
        assert.equal(result.attachments[0]!.audit.wasOptimized, false);
        assert.equal(
            result.attachments[0]!.audit.originalSha256,
            result.attachments[0]!.audit.outputSha256
        );
    });

    it('AK-13: beendet die Optimierung, sobald das Budget erreicht ist', async () => {
        const pdf = new FakeOptimizer(PDF_MIME, pdfLadder, { factor: { structural: 0.4 } });
        const pipeline = new AttachmentOptimizationPipeline([pdf]);

        const result = await pipeline.run(
            [file('gross.pdf', PDF_MIME, 1000), file('klein.pdf', PDF_MIME, 100)],
            600,
            policy(),
            LIMITS
        );

        assert.ok(result.ok);
        // The big file at `structural` is 400; 400 + 100 fits, so the small one
        // is never touched and no stronger rung is ever entered.
        assert.deepEqual(pdf.produced, ['gross.pdf@structural']);
        assert.equal(result.attachments[1]!.audit.wasOptimized, false);
    });

    it('AK-17: meldet attachment_budget_not_reached, wenn nichts ausreicht', async () => {
        const pdf = new FakeOptimizer(PDF_MIME, pdfLadder, { factor: { structural: 0.99, balanced: 0.98, compact: 0.97 } });
        const pipeline = new AttachmentOptimizationPipeline([pdf]);

        const result = await pipeline.run([file('a.pdf', PDF_MIME, 1000)], 100, policy(), LIMITS);

        assert.equal(result.ok, false);
        assert.ok(!result.ok);
        assert.equal(result.reason, 'attachment_budget_not_reached');
    });

    it('lehnt Eingaben über dem Verarbeitungslimit ab, bevor irgendetwas geladen wird', async () => {
        const pdf = new FakeOptimizer(PDF_MIME, pdfLadder);
        const pipeline = new AttachmentOptimizationPipeline([pdf]);

        const single = await pipeline.run([file('a.pdf', PDF_MIME, 2000)], 100, policy(), {
            ...LIMITS,
            maxSingleInputBytes: 1000
        });
        assert.ok(!single.ok);
        assert.equal(single.reason, 'attachment_input_too_large');

        const total = await pipeline.run(
            [file('a.pdf', PDF_MIME, 800), file('b.pdf', PDF_MIME, 800)],
            100,
            policy(),
            { ...LIMITS, maxTotalInputBytes: 1000 }
        );
        assert.ok(!total.ok);
        assert.equal(total.reason, 'attachment_input_too_large');
        assert.equal(pdf.produced.length, 0);
    });
});

describe('US-001 Pipeline: Policy als Obergrenze', () => {
    it('AK-14: führt compact nicht aus, wenn nur balanced freigegeben ist', async () => {
        const pdf = new FakeOptimizer(PDF_MIME, pdfLadder, {
            factor: { structural: 0.95, balanced: 0.9, compact: 0.1 }
        });
        const pipeline = new AttachmentOptimizationPipeline([pdf]);

        const result = await pipeline.run([file('a.pdf', PDF_MIME, 1000)], 200, policy('balanced'), LIMITS);

        assert.ok(!result.ok);
        assert.equal(result.reason, 'attachment_budget_not_reached');
        assert.ok(!pdf.produced.some((entry) => entry.endsWith('@compact')));
    });

    it('AK-3: verwendet nur Formate aus der gebundenen Policy', async () => {
        const pdf = new FakeOptimizer(PDF_MIME, pdfLadder, { factor: { structural: 0.1 } });
        const jpeg = new FakeOptimizer(JPEG_MIME, jpegLadder, { factor: { balanced: 0.1 } });
        const pipeline = new AttachmentOptimizationPipeline([pdf, jpeg]);

        const result = await pipeline.run(
            [file('a.pdf', PDF_MIME, 1000), file('b.jpg', JPEG_MIME, 1000)],
            300,
            policy('compact', [JPEG_MIME]),
            LIMITS
        );

        assert.ok(!result.ok, 'ohne PDF-Erlaubnis ist das Budget nicht erreichbar');
        assert.equal(pdf.produced.length, 0, 'PDF darf ohne Freigabe nicht angefasst werden');
        assert.deepEqual(jpeg.produced, ['b.jpg@balanced', 'b.jpg@compact']);
    });

    it('AK-16: lässt Dateien unverändert, die weder PDF noch JPEG sind', async () => {
        const pdf = new FakeOptimizer(PDF_MIME, pdfLadder, { factor: { structural: 0.1 } });
        const pipeline = new AttachmentOptimizationPipeline([pdf]);
        const other = file('notiz.txt', 'text/plain', 500, 9);

        const result = await pipeline.run(
            [file('a.pdf', PDF_MIME, 1000), other],
            700,
            policy(),
            LIMITS
        );

        assert.ok(result.ok);
        assert.deepEqual(result.attachments[1]!.bytes, other.bytes);
        assert.equal(result.attachments[1]!.audit.wasOptimized, false);
    });
});

describe('US-001 Pipeline: Reihenfolge und Kandidatenannahme', () => {
    it('AK-15: bearbeitet die größte Datei zuerst, bei Gleichstand die Anhangsreihenfolge', async () => {
        const pdf = new FakeOptimizer(PDF_MIME, pdfLadder, { factor: { structural: 0.99 } });
        const pipeline = new AttachmentOptimizationPipeline([pdf]);

        await pipeline.run(
            [
                file('zuerst-gleich.pdf', PDF_MIME, 500),
                file('groesste.pdf', PDF_MIME, 900),
                file('danach-gleich.pdf', PDF_MIME, 500)
            ],
            1,
            policy('structural'),
            LIMITS
        );

        assert.deepEqual(pdf.produced, [
            'groesste.pdf@structural',
            'zuerst-gleich.pdf@structural',
            'danach-gleich.pdf@structural'
        ]);
    });

    it('AK-22: wählt bei gleicher Eingabe dieselbe Stufen- und Profilreihenfolge', async () => {
        const runOnce = async (): Promise<string[]> => {
            const pdf = new FakeOptimizer(PDF_MIME, pdfLadder, { factor: { structural: 0.9, balanced: 0.8 } });
            const jpeg = new FakeOptimizer(JPEG_MIME, jpegLadder, { factor: { balanced: 0.9, compact: 0.8 } });
            const pipeline = new AttachmentOptimizationPipeline([pdf, jpeg]);
            await pipeline.run(
                [file('a.pdf', PDF_MIME, 1000), file('b.jpg', JPEG_MIME, 900)],
                1,
                policy(),
                LIMITS
            );
            return [...pdf.produced, ...jpeg.produced];
        };

        assert.deepEqual(await runOnce(), await runOnce());
    });

    it('folgt der dokumentierten Prioritätsreihenfolge der Story', () => {
        assert.deepEqual(
            STAGES.map((stage) => `${stage.mimeType}:${stage.profile}`),
            [
                `${PDF_MIME}:structural`,
                `${JPEG_MIME}:balanced`,
                `${PDF_MIME}:balanced`,
                `${JPEG_MIME}:compact`,
                `${PDF_MIME}:compact`
            ]
        );
    });

    it('AK-9/AK-7: erzeugt jeden Kandidaten aus dem Original, nie aus einem Derivat', async () => {
        const pdf = new FakeOptimizer(PDF_MIME, pdfLadder, { factor: { structural: 0.9, balanced: 0.8, compact: 0.7 } });
        const pipeline = new AttachmentOptimizationPipeline([pdf]);
        const input = file('a.pdf', PDF_MIME, 1000);

        await pipeline.run([input], 1, policy(), LIMITS);

        assert.equal(pdf.seenInputs.length, 3, 'alle drei Stufen wurden versucht');
        for (const seen of pdf.seenInputs) {
            assert.equal(seen.byteLength, 1000, 'immer die Originalgröße');
            assert.deepEqual(seen, input.bytes, 'immer die Originalbytes');
        }
    });

    it('AK-11: verwirft einen Kandidaten, der größer ist als der bisherige Stand', async () => {
        const pdf = new FakeOptimizer(PDF_MIME, pdfLadder, {
            absolute: { structural: 400, balanced: 900 }
        });
        const pipeline = new AttachmentOptimizationPipeline([pdf]);

        const result = await pipeline.run([file('a.pdf', PDF_MIME, 1000)], 350, policy(), LIMITS);

        assert.ok(!result.ok, '900 wird verworfen, 400 reicht nicht');
        // The 400-byte structural result is kept; the 900-byte balanced result
        // must not replace it just because it is newer.
        assert.deepEqual(pdf.produced, ['a.pdf@structural', 'a.pdf@balanced', 'a.pdf@compact']);
    });

    it('AK-18: verwirft ein fehlgeschlagenes Derivat und prüft die nächste Stufe weiter', async () => {
        const pdf = new FakeOptimizer(PDF_MIME, pdfLadder, {
            fail: ['structural', 'balanced'],
            factor: { compact: 0.2 }
        });
        const pipeline = new AttachmentOptimizationPipeline([pdf]);

        const result = await pipeline.run([file('a.pdf', PDF_MIME, 1000)], 300, policy(), LIMITS);

        assert.ok(result.ok);
        assert.equal(result.attachments[0]!.bytes.byteLength, 200);
        assert.equal(result.attachments[0]!.audit.profile, 'compact');
    });
});

describe('US-001 Pipeline: nicht transformierbare Dateien', () => {
    it('AK-4: verändert eine vom Preflight abgelehnte PDF nicht', async () => {
        const pdf = new FakeOptimizer(PDF_MIME, pdfLadder, {
            refuse: ['signiert.pdf'],
            factor: { structural: 0.1 }
        });
        const pipeline = new AttachmentOptimizationPipeline([pdf]);
        const signed = file('signiert.pdf', PDF_MIME, 400, 3);

        const result = await pipeline.run(
            [signed, file('normal.pdf', PDF_MIME, 1000)],
            600,
            policy(),
            LIMITS
        );

        assert.ok(result.ok);
        assert.deepEqual(result.attachments[0]!.bytes, signed.bytes);
        assert.equal(result.attachments[0]!.audit.wasOptimized, false);
        assert.ok(!pdf.produced.some((entry) => entry.startsWith('signiert.pdf')));
    });

    it('AK-5: bricht ab, wenn eine nicht transformierbare PDF das Budget verhindert', async () => {
        const pdf = new FakeOptimizer(PDF_MIME, pdfLadder, { refuse: ['signiert.pdf'] });
        const pipeline = new AttachmentOptimizationPipeline([pdf]);

        const result = await pipeline.run([file('signiert.pdf', PDF_MIME, 1000)], 100, policy(), LIMITS);

        assert.ok(!result.ok);
        assert.equal(result.reason, 'attachment_budget_not_reached');
    });
});

describe('US-001 Pipeline: Fehler und Zeitbudget', () => {
    it('AK-19: scheitert kontrolliert, wenn das Zeitbudget überschritten ist', async () => {
        const pdf = new FakeOptimizer(PDF_MIME, pdfLadder, {
            throwOn: { structural: new OptimizationTimeoutError('zu langsam') }
        });
        const pipeline = new AttachmentOptimizationPipeline([pdf]);

        const result = await pipeline.run([file('a.pdf', PDF_MIME, 1000)], 100, policy(), LIMITS);

        assert.ok(!result.ok);
        assert.equal(result.reason, 'attachment_optimization_timeout');
    });

    it('meldet ein fehlendes Werkzeug getrennt von einem zu knappen Budget', async () => {
        const pdf = new FakeOptimizer(PDF_MIME, pdfLadder, { available: false });
        const pipeline = new AttachmentOptimizationPipeline([pdf]);

        const result = await pipeline.run([file('a.pdf', PDF_MIME, 1000)], 100, policy(), LIMITS);

        assert.ok(!result.ok);
        assert.equal(result.reason, 'attachment_optimizer_unavailable');
        assert.match(result.detail, /fake-application\/pdf/);
    });

    it('AK-24: entfernt das temporäre Arbeitsverzeichnis auch im Fehlerfall', async () => {
        const before = (await readdir(tmpdir())).filter((entry) => entry.startsWith('ltg-attach-'));
        await assert.rejects(
            () =>
                withWorkspace(async () => {
                    throw new Error('Abbruch mitten im Lauf');
                }),
            /Abbruch mitten im Lauf/
        );
        const after = (await readdir(tmpdir())).filter((entry) => entry.startsWith('ltg-attach-'));
        assert.deepEqual(after, before);
    });
});

describe('US-001 ProcessRunner', () => {
    const runner = new ProcessRunner({ test: 1 });

    it('übergibt Argumente getrennt und ohne Shell-Auswertung', async () => {
        // Would be a wildcard or a command substitution under a shell; here it
        // has to arrive as one literal argument.
        const payload = '$(touch /tmp/ltg-should-not-exist); *';
        const result = await runner.run({
            command: 'printf',
            args: ['%s', payload],
            timeoutMs: 5000
        });
        assert.equal(result.code, 0);
        assert.equal(result.stdout, payload);
    });

    it('bricht einen überfälligen Prozess ab, statt zu warten', async () => {
        await assert.rejects(
            () => runner.run({ command: 'sleep', args: ['30'], timeoutMs: 150 }),
            ProcessTimeoutError
        );
    });

    it('meldet ein fehlendes Programm als Startfehler', async () => {
        await assert.rejects(() =>
            runner.run({ command: 'ltg-gibt-es-nicht', args: [], timeoutMs: 2000 })
        );
    });

    it('begrenzt die mitgeschriebene Ausgabe', async () => {
        const small = new ProcessRunner({}, 64);
        const result = await small.run({
            command: 'sh',
            args: ['-c', 'printf "x%.0s" $(seq 1 5000)'],
            timeoutMs: 10_000
        });
        assert.equal(result.stdout.length, 64);
    });

    it('serialisiert Läufe in derselben Spur', async () => {
        const serial = new ProcessRunner({ nur_einer: 1 });
        let running = 0;
        let peak = 0;
        await Promise.all(
            [0, 1, 2].map(async () => {
                running += 1;
                peak = Math.max(peak, running);
                await serial.run({ command: 'true', args: [], lane: 'nur_einer', timeoutMs: 5000 });
                running -= 1;
            })
        );
        assert.ok(peak <= 3);
    });
});

/**
 * `PdfOptimizer` driven through a scripted `ProcessRunner`.
 *
 * qpdf is not installed on every machine, and `validate` is the branch that
 * decides whether a Ghostscript derivative is allowed to become an attachment
 * at all — it must not be the branch nothing ever executes. The runner below
 * stands in for the binaries and behaves exactly as qpdf's documented exit
 * codes say it would: 0 clean, 2 error, 3 warnings.
 */
class ScriptedRunner extends ProcessRunner {
    readonly seen: string[][] = [];

    constructor(private readonly checkExitCode: number) {
        super();
    }

    override async run(spec: { command: string; args: string[] }): Promise<{
        code: number;
        stdout: string;
        stderr: string;
    }> {
        this.seen.push([spec.command, ...spec.args]);
        const args = spec.args;
        const reply = (code: number, stdout = ''): { code: number; stdout: string; stderr: string } => ({
            code,
            stdout,
            stderr: ''
        });
        if (args[0] === '--version') {
            return reply(0, spec.command === 'qpdf' ? 'qpdf version 11.9.0' : '10.07.1');
        }
        // Exit 2 from `--is-encrypted` means "not encrypted".
        if (args[0] === '--is-encrypted') {
            return reply(2);
        }
        if (args[0] === '--show-npages') {
            return reply(0, '1\n');
        }
        if (args[0] === '--check') {
            return reply(this.checkExitCode);
        }
        // Both the preflight expansion and the structural pass write their
        // output file, which is what the real qpdf would do.
        const output = args[args.length - 1]!;
        await writeFile(output, Buffer.from('%PDF-1.7\nstrukturell verkleinert\n%%EOF\n'));
        return reply(0);
    }
}

describe('US-001 PDF-Adapter: Validierung eines Derivats', () => {
    const original = Buffer.concat([
        Buffer.from('%PDF-1.7\n'),
        Buffer.alloc(4000, 0x41),
        Buffer.from('\n%%EOF\n')
    ]);
    const input: OptimizationInput = {
        filename: 'scan.pdf',
        mimeType: PDF_MIME,
        bytes: new Uint8Array(original),
        sha256: sha256Bytes(new Uint8Array(original))
    };

    const withOptimizer = async (
        checkExitCode: number,
        rejectOnWarnings: boolean,
        body: (optimizer: PdfOptimizer, ctx: OptimizationContext) => Promise<void>
    ): Promise<void> => {
        const runner = new ScriptedRunner(checkExitCode);
        const optimizer = new PdfOptimizer(runner, { rejectOnWarnings });
        await withWorkspace(async (workspaceDir) => {
            await body(optimizer, { deadlineAt: Date.now() + 30_000, workspaceDir });
        });
    };

    it('übernimmt einen Kandidaten, dessen Prüfung sauber durchläuft', async () => {
        await withOptimizer(0, false, async (optimizer, ctx) => {
            const candidate = await optimizer.produce(input, 'structural', { pages: 1 }, ctx);
            assert.ok(candidate, 'ein sauber geprüfter Kandidat muss angenommen werden');
            assert.equal(candidate.profile, 'structural');
            assert.equal(candidate.optimizer, 'qpdf');
        });
    });

    it('verwirft einen Kandidaten, dessen Prüfung einen Strukturfehler meldet', async () => {
        await withOptimizer(2, false, async (optimizer, ctx) => {
            assert.equal(
                await optimizer.produce(input, 'structural', { pages: 1 }, ctx),
                undefined,
                'ein Exit-Code 2 ist ein Fehler und disqualifiziert immer'
            );
        });
    });

    it('akzeptiert Warnungen standardmäßig und verwirft sie nach Policy', async () => {
        await withOptimizer(3, false, async (optimizer, ctx) => {
            assert.ok(
                await optimizer.produce(input, 'structural', { pages: 1 }, ctx),
                'Standard: Warnungen (Exit 3) disqualifizieren nicht'
            );
        });
        await withOptimizer(3, true, async (optimizer, ctx) => {
            assert.equal(
                await optimizer.produce(input, 'structural', { pages: 1 }, ctx),
                undefined,
                'rejectOnWarnings: Warnungen disqualifizieren'
            );
        });
    });

    it('verwirft einen Kandidaten mit abweichender Seitenzahl', async () => {
        await withOptimizer(0, false, async (optimizer, ctx) => {
            // The scripted runner always answers "1 page"; expecting 7 is the
            // rewrite-lost-pages case.
            assert.equal(await optimizer.produce(input, 'structural', { pages: 7 }, ctx), undefined);
        });
    });

    it('AK-4: erkennt eine verschlüsselte PDF im Preflight', async () => {
        const runner = new (class extends ScriptedRunner {
            override async run(spec: { command: string; args: string[] }) {
                // Exit 0 from `--is-encrypted` means "encrypted".
                return spec.args[0] === '--is-encrypted'
                    ? { code: 0, stdout: '', stderr: '' }
                    : super.run(spec);
            }
        })(0);
        const optimizer = new PdfOptimizer(runner);
        await withWorkspace(async (workspaceDir) => {
            const verdict = await optimizer.preflight(input, {
                deadlineAt: Date.now() + 30_000,
                workspaceDir
            });
            assert.equal(verdict.transformable, false);
            assert.equal(verdict.reason, 'verschluesselt');
        });
    });

    it('AK-4: erkennt ein interaktives Formular und lässt es unangetastet', async () => {
        const runner = new (class extends ScriptedRunner {
            override async run(spec: { command: string; args: string[] }) {
                if (spec.args[0] === '--object-streams=disable') {
                    await writeFile(
                        spec.args[spec.args.length - 1]!,
                        Buffer.from('%PDF-1.7\n<< /AcroForm 9 0 R >>\n%%EOF\n')
                    );
                    return { code: 0, stdout: '', stderr: '' };
                }
                return super.run(spec);
            }
        })(0);
        const optimizer = new PdfOptimizer(runner);
        await withWorkspace(async (workspaceDir) => {
            const verdict = await optimizer.preflight(input, {
                deadlineAt: Date.now() + 30_000,
                workspaceDir
            });
            assert.equal(verdict.transformable, false);
            assert.equal(verdict.reason, 'formular');
        });
    });
});

describe('US-001 Pipeline: Arbeitsvolumen', () => {
    it('unterscheidet ein erschöpftes Arbeitsvolumen von zu großen Dokumenten', async () => {
        const pdf = new FakeOptimizer(PDF_MIME, pdfLadder, { factor: { structural: 0.1 } });
        const pipeline = new AttachmentOptimizationPipeline([pdf]);

        const result = await pipeline.run([file('a.pdf', PDF_MIME, 1000)], 100, policy(), {
            ...LIMITS,
            // Room for the original, but not for the original plus one candidate.
            maxWorkingBytes: 1500
        });

        assert.ok(!result.ok);
        assert.equal(result.reason, 'attachment_input_too_large');
        assert.match(result.detail, /Arbeitsvolumen/);
        assert.equal(pdf.produced.length, 0);
    });
});

describe('US-001 Transformationspolicy', () => {
    it('lässt die Policy weg, solange ein Ziel nicht optimieren darf', () => {
        assert.equal(buildTransformPolicy({ mode: 'disabled', pdf: true, jpeg: true }), undefined);
        assert.equal(buildTransformPolicy({ mode: 'balanced', pdf: false, jpeg: false }), undefined);
    });

    it('bindet Version, Obergrenze und Formate in stabiler Reihenfolge', () => {
        assert.deepEqual(buildTransformPolicy({ mode: 'balanced', pdf: true, jpeg: true }), {
            policyVersion: POLICY_VERSION,
            maxProfile: 'balanced',
            formats: [PDF_MIME, JPEG_MIME].sort()
        });
        assert.deepEqual(buildTransformPolicy({ mode: 'compact', pdf: false, jpeg: true }), {
            policyVersion: POLICY_VERSION,
            maxProfile: 'compact',
            formats: [JPEG_MIME]
        });
    });
});
