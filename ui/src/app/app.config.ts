import {
    type ApplicationConfig,
    provideBrowserGlobalErrorListeners,
    provideZonelessChangeDetection
} from '@angular/core';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { provideRouter, withComponentInputBinding, withInMemoryScrolling } from '@angular/router';
import { routes } from './app.routes';
import { tokenInterceptor } from './core/auth';

export const appConfig: ApplicationConfig = {
    providers: [
        provideBrowserGlobalErrorListeners(),
        provideZonelessChangeDetection(),
        provideRouter(
            routes,
            // Selecting an action puts its id in the URL, so a detail view is
            // reloadable rather than a state that only exists until refresh.
            withComponentInputBinding(),
            withInMemoryScrolling({ scrollPositionRestoration: 'top' })
        ),
        provideHttpClient(withInterceptors([tokenInterceptor]))
    ]
};
