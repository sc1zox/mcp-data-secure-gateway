import { strict as assert } from 'node:assert';
import { readFile, writeFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import sharpNamespace from 'sharp';
import { JpegOptimizer } from '../src/attachments/jpegOptimizer.js';
import { PdfOptimizer } from '../src/attachments/pdfOptimizer.js';
import { AttachmentOptimizationPipeline } from '../src/attachments/pipeline.js';
import { ProcessRunner, withWorkspace, workspacePath } from '../src/attachments/processRunner.js';
import { PDF_PROFILES, ghostscriptArgs } from '../src/attachments/profiles.js';
import type { OptimizationLimits } from '../src/attachments/types.js';
import { JPEG_MIME, PDF_MIME } from '../src/attachments/types.js';
import type { ApprovedTransformPolicy } from '../src/core/types.js';
import { sha256Bytes } from '../src/util/hash.js';

/**
 * The real tool chain, as opposed to `attachments.test.ts` which drives doubles.
 *
 * Each block skips itself when its binary is absent, because the Definition of
 * Done requires the ordinary test run to pass without qpdf or Ghostscript
 * installed. A skipped test is reported as skipped rather than passing quietly,
 * so "the PDF chain was never actually exercised here" stays visible.
 */

const sharp = sharpNamespace as unknown as typeof sharpNamespace;
const runner = new ProcessRunner({ ghostscript: 1, qpdf: 2 });

const LIMITS: OptimizationLimits = {
    maxSingleInputBytes: 50 * 1024 * 1024,
    maxTotalInputBytes: 100 * 1024 * 1024,
    maxWorkingBytes: 300 * 1024 * 1024,
    timeBudgetMs: 60_000
};

const FULL_POLICY: ApprovedTransformPolicy = {
    policyVersion: 'test',
    maxProfile: 'compact',
    formats: [PDF_MIME, JPEG_MIME].sort()
};

async function hasBinary(command: string): Promise<boolean> {
    try {
        const result = await runner.run({ command, args: ['--version'], timeoutMs: 10_000 });
        return result.code === 0;
    } catch {
        return false;
    }
}

/** A noisy photograph-like JPEG; noise keeps the encoder honest about quality. */
async function makePhoto(width: number, height: number, quality = 95): Promise<Buffer> {
    const raw = Buffer.alloc(width * height * 3);
    for (let i = 0; i < raw.length; i += 1) {
        raw[i] = (Math.sin(i * 0.0137) * 110 + 128) | 0;
    }
    return sharp(raw, { raw: { width, height, channels: 3 } }).jpeg({ quality }).toBuffer();
}

/**
 * A one-page PDF wrapping `jpeg` as a DCTDecode image.
 *
 * Written by hand rather than produced by a tool, because the point is to have
 * a PDF whose bulk is a single high-resolution image — exactly the shape of the
 * scanned certificate this feature exists for, and the shape Ghostscript can
 * actually make smaller.
 */
function buildPdfWithImage(jpeg: Buffer, width: number, height: number): Buffer {
    const parts: Buffer[] = [];
    const offsets: number[] = [];
    let cursor = 0;
    const push = (chunk: Buffer | string): void => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'latin1');
        parts.push(buffer);
        cursor += buffer.byteLength;
    };
    const startObject = (): void => {
        offsets.push(cursor);
    };

    push('%PDF-1.7\n');
    startObject();
    push('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
    startObject();
    push('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n');
    startObject();
    push(
        '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] ' +
            '/Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>\nendobj\n'
    );
    startObject();
    push(
        `4 0 obj\n<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} ` +
            `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.byteLength} >>\nstream\n`
    );
    push(jpeg);
    push('\nendstream\nendobj\n');
    const content = 'q 595 0 0 842 0 0 cm /Im0 Do Q\n';
    startObject();
    push(`5 0 obj\n<< /Length ${content.length} >>\nstream\n${content}endstream\nendobj\n`);

    const xrefAt = cursor;
    let xref = 'xref\n0 6\n0000000000 65535 f \n';
    for (const offset of offsets) {
        xref += `${String(offset).padStart(10, '0')} 00000 n \n`;
    }
    push(xref);
    push(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`);
    return Buffer.concat(parts);
}

describe('US-001 echte Werkzeuge: JPEG über Sharp', () => {
    it('AK-8/AK-9/AK-10: bleibt JPEG, richtet sich korrekt aus, verliert EXIF und GPS', async () => {
        const photo = await makePhoto(3000, 2000);
        const original = await sharp(photo)
            .withExif({
                IFD0: { Model: 'Testkamera', Software: 'Testsoftware' },
                GPS: { GPSLatitudeRef: 'N', GPSLongitudeRef: 'E' }
            })
            // 6 means "rotate 90° clockwise for display": stored landscape,
            // seen as portrait.
            .withMetadata({ orientation: 6 })
            .toBuffer();

        const before = await sharp(original).metadata();
        assert.equal(before.orientation, 6);
        assert.ok(before.exif, 'die Vorlage trägt EXIF-Daten');

        const optimizer = new JpegOptimizer();
        const pipeline = new AttachmentOptimizationPipeline([optimizer]);
        const input = {
            filename: 'foto.jpg',
            mimeType: JPEG_MIME,
            bytes: new Uint8Array(original),
            sha256: sha256Bytes(new Uint8Array(original))
        };

        const result = await pipeline.run(
            [input],
            Math.floor(original.byteLength / 2),
            FULL_POLICY,
            LIMITS
        );

        assert.ok(result.ok, 'das Budget wird erreicht');
        const delivered = result.attachments[0]!;
        assert.equal(delivered.filename, 'foto.jpg', 'der Dateiname bleibt unverändert');
        assert.ok(delivered.bytes.byteLength < original.byteLength);

        const after = await sharp(Buffer.from(delivered.bytes)).metadata();
        assert.equal(after.format, 'jpeg', 'AK-8: die Ausgabe bleibt ein JPEG');
        assert.equal(after.space, 'srgb', 'AK-10: die Ausgabe ist sRGB');
        assert.ok(!after.exif, 'AK-9: EXIF und GPS sind entfernt');
        assert.ok(!after.orientation || after.orientation === 1);
        // AK-8: the rotation is now in the pixels. Landscape 3:2 stored with
        // orientation 6 must come out portrait, i.e. taller than wide.
        assert.ok(
            after.height! > after.width!,
            `sichtbare Orientierung bleibt hochkant (${after.width}x${after.height})`
        );
    });

    it('AK-21: protokolliert Original- und Ausgabegröße samt beider Hashes', async () => {
        const photo = await makePhoto(2400, 1800);
        const optimizer = new JpegOptimizer();
        const pipeline = new AttachmentOptimizationPipeline([optimizer]);
        const bytes = new Uint8Array(photo);
        const result = await pipeline.run(
            [{ filename: 'a.jpg', mimeType: JPEG_MIME, bytes, sha256: sha256Bytes(bytes) }],
            Math.floor(photo.byteLength / 2),
            FULL_POLICY,
            LIMITS
        );

        assert.ok(result.ok);
        const audit = result.attachments[0]!.audit;
        assert.equal(audit.wasOptimized, true);
        assert.equal(audit.originalBytes, photo.byteLength);
        assert.equal(audit.originalSha256, sha256Bytes(bytes));
        assert.equal(audit.outputBytes, result.attachments[0]!.bytes.byteLength);
        // The digest must be of the bytes actually handed over, not of a plan.
        assert.equal(audit.outputSha256, sha256Bytes(result.attachments[0]!.bytes));
        assert.notEqual(audit.originalSha256, audit.outputSha256);
        assert.match(audit.toolVersion!, /^sharp /);
        assert.equal(audit.optimizer, 'sharp');
    });

    it('vergrößert ein bereits kleines Bild nicht', async () => {
        const small = await makePhoto(400, 300, 40);
        const optimizer = new JpegOptimizer();
        const candidate = await optimizer.produce(
            {
                filename: 's.jpg',
                mimeType: JPEG_MIME,
                bytes: new Uint8Array(small),
                sha256: sha256Bytes(new Uint8Array(small))
            },
            'balanced',
            { width: 400, height: 300 },
            { deadlineAt: Date.now() + 30_000, workspaceDir: '' }
        );

        assert.ok(candidate);
        const metadata = await sharp(Buffer.from(candidate.bytes)).metadata();
        assert.equal(metadata.width, 400);
        assert.equal(metadata.height, 300);
    });

    it('lehnt eine Datei ab, die kein JPEG ist', async () => {
        const png = await sharp({
            create: { width: 20, height: 20, channels: 3, background: '#336699' }
        })
            .png()
            .toBuffer();
        const optimizer = new JpegOptimizer();
        const verdict = await optimizer.preflight(
            {
                filename: 'x.jpg',
                mimeType: JPEG_MIME,
                bytes: new Uint8Array(png),
                sha256: sha256Bytes(new Uint8Array(png))
            },
            { deadlineAt: Date.now() + 30_000, workspaceDir: '' }
        );
        assert.equal(verdict.transformable, false);
        assert.equal(verdict.reason, 'kein_jpeg');
    });
});

describe('US-001 echte Werkzeuge: Ghostscript-Profile', () => {
    it('verkleinert eine bildlastige PDF mit dem balanced-Profil', async (t) => {
        if (!(await hasBinary('gs'))) {
            t.skip('Ghostscript ist nicht installiert.');
            return;
        }
        const jpeg = await makePhoto(2400, 3200);
        const pdf = buildPdfWithImage(jpeg, 2400, 3200);

        await withWorkspace(async (dir) => {
            const input = workspacePath(dir, '.pdf');
            const output = workspacePath(dir, '.out.pdf');
            await writeFile(input, pdf);

            const result = await runner.run({
                command: 'gs',
                args: ghostscriptArgs(PDF_PROFILES.balanced, input, output),
                lane: 'ghostscript',
                timeoutMs: 120_000
            });
            assert.equal(result.code, 0, `Ghostscript meldete: ${result.stderr.slice(0, 300)}`);

            const produced = await readFile(output);
            assert.ok(produced.byteLength > 0);
            assert.equal(produced.subarray(0, 5).toString('latin1'), '%PDF-');
            assert.ok(
                produced.byteLength < pdf.byteLength,
                `erwartet kleiner als ${pdf.byteLength}, war ${produced.byteLength}`
            );
        });
    });

    it('erzeugt mit compact ein kleineres Ergebnis als mit balanced', async (t) => {
        if (!(await hasBinary('gs'))) {
            t.skip('Ghostscript ist nicht installiert.');
            return;
        }
        const jpeg = await makePhoto(2400, 3200);
        const pdf = buildPdfWithImage(jpeg, 2400, 3200);

        await withWorkspace(async (dir) => {
            const input = workspacePath(dir, '.pdf');
            await writeFile(input, pdf);
            const sizes: Record<string, number> = {};
            for (const profile of ['balanced', 'compact'] as const) {
                const output = workspacePath(dir, `.${profile}.pdf`);
                const result = await runner.run({
                    command: 'gs',
                    args: ghostscriptArgs(PDF_PROFILES[profile], input, output),
                    lane: 'ghostscript',
                    timeoutMs: 120_000
                });
                assert.equal(result.code, 0);
                sizes[profile] = (await readFile(output)).byteLength;
            }
            assert.ok(
                sizes.compact! < sizes.balanced!,
                `compact (${sizes.compact}) muss unter balanced (${sizes.balanced}) liegen`
            );
        });
    });
});

describe('US-001 echte Werkzeuge: PDF-Kette über qpdf', () => {
    it('AK-6/AK-7: erkennt die Seitenzahl und liefert einen gültigen Kandidaten', async (t) => {
        if (!(await hasBinary('qpdf')) || !(await hasBinary('gs'))) {
            t.skip('qpdf und/oder Ghostscript sind nicht installiert.');
            return;
        }
        const jpeg = await makePhoto(2000, 2600);
        const pdf = buildPdfWithImage(jpeg, 2000, 2600);
        const optimizer = new PdfOptimizer(runner);

        await withWorkspace(async (workspaceDir) => {
            const ctx = { deadlineAt: Date.now() + 120_000, workspaceDir };
            const input = {
                filename: 'scan.pdf',
                mimeType: PDF_MIME,
                bytes: new Uint8Array(pdf),
                sha256: sha256Bytes(new Uint8Array(pdf))
            };

            const verdict = await optimizer.preflight(input, ctx);
            assert.equal(verdict.transformable, true, `Preflight lehnte ab: ${verdict.reason}`);
            assert.equal(verdict.signature?.pages, 1);

            const candidate = await optimizer.produce(input, 'balanced', verdict.signature, ctx);
            assert.ok(candidate, 'Ghostscript lieferte keinen gültigen Kandidaten');
            assert.ok(candidate.bytes.byteLength < pdf.byteLength);
            assert.equal(Buffer.from(candidate.bytes.subarray(0, 5)).toString('latin1'), '%PDF-');
        });
    });

    it('AK-4: rührt eine verschlüsselte PDF nicht an', async (t) => {
        if (!(await hasBinary('qpdf'))) {
            t.skip('qpdf ist nicht installiert.');
            return;
        }
        const jpeg = await makePhoto(600, 800);
        const pdf = buildPdfWithImage(jpeg, 600, 800);
        const optimizer = new PdfOptimizer(runner);

        await withWorkspace(async (workspaceDir) => {
            const plain = workspacePath(workspaceDir, '.pdf');
            const encrypted = workspacePath(workspaceDir, '.enc.pdf');
            await writeFile(plain, pdf);
            const encryption = await runner.run({
                command: 'qpdf',
                args: ['--encrypt', 'geheim', 'geheim', '256', '--', plain, encrypted],
                timeoutMs: 30_000
            });
            assert.ok(encryption.code === 0 || encryption.code === 3);

            const bytes = new Uint8Array(await readFile(encrypted));
            const verdict = await optimizer.preflight(
                { filename: 'e.pdf', mimeType: PDF_MIME, bytes, sha256: sha256Bytes(bytes) },
                { deadlineAt: Date.now() + 60_000, workspaceDir }
            );
            assert.equal(verdict.transformable, false);
            assert.equal(verdict.reason, 'verschluesselt');
        });
    });

    it('meldet fehlende Werkzeuge als Unverfügbarkeit statt zu stürzen', async () => {
        const optimizer = new PdfOptimizer(runner, {
            qpdfCommand: 'ltg-qpdf-gibt-es-nicht',
            ghostscriptCommand: 'ltg-gs-gibt-es-nicht'
        });
        const availability = await optimizer.available();
        assert.equal(availability.available, false);
        assert.match(availability.detail!, /Nicht installiert/);
    });
});
