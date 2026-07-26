import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { App } from './app/app';
import { consumeTokenFromUrl } from './app/core/session';

// Runs before the router's initial navigation, so the auth guard never evaluates
// against a session that the URL was about to establish.
consumeTokenFromUrl();

bootstrapApplication(App, appConfig).catch((error: unknown) => {
    console.error('Die Freigabeoberfläche konnte nicht starten.', error);
});
