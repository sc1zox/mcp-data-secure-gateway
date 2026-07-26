import { Injectable, inject } from '@angular/core';
import { MatSnackBar } from '@angular/material/snack-bar';

/**
 * Transient feedback. Errors stay noticeably longer than confirmations and are
 * dismissible, because an error here often carries the only explanation of why an
 * approval did not go through.
 */
@Injectable({ providedIn: 'root' })
export class Notify {
    private readonly snackBar = inject(MatSnackBar);

    ok(message: string): void {
        this.snackBar.open(message, 'OK', {
            duration: 4000,
            panelClass: 'ltg-snack-ok',
            horizontalPosition: 'center',
            verticalPosition: 'bottom'
        });
    }

    error(message: string): void {
        this.snackBar.open(message, 'Schließen', {
            duration: 10000,
            panelClass: 'ltg-snack-error',
            horizontalPosition: 'center',
            verticalPosition: 'bottom'
        });
    }
}
