import { Injectable } from '@angular/core';
import {
  HttpInterceptor,
  HttpRequest,
  HttpHandler,
  HttpEvent
} from '@angular/common/http';
import { Observable, throwError } from 'rxjs';
import { catchError } from 'rxjs/operators';
import { Router } from '@angular/router';

/** Routes that skip the standard Bearer token (handled separately or truly public) */
const PUBLIC_PATHS = [
  '/login',
  '/forgot/check-email',
  '/forgot/send-otp',
  '/forgot/verify-otp',
  '/forgot/reset-password',
];

@Injectable()
export class AuthInterceptor implements HttpInterceptor {

  constructor(private router: Router) {}

  intercept(req: HttpRequest<any>, next: HttpHandler): Observable<HttpEvent<any>> {
    // /verify-otp needs the *tempToken* (pre-OTP session), not the final token
    if (req.url.includes('/verify-otp')) {
      const tempToken = localStorage.getItem('tempToken');
      if (tempToken) {
        return next.handle(req.clone({
          setHeaders: { Authorization: `Bearer ${tempToken}` }
        }));
      }
      return next.handle(req);
    }

    const isPublic = PUBLIC_PATHS.some(path => req.url.includes(path));
    if (isPublic) {
      return next.handle(req);
    }

    const token = localStorage.getItem('token');
    const cloned = token
      ? req.clone({ setHeaders: { Authorization: `Bearer ${token}` } })
      : req;

    return next.handle(cloned).pipe(
      catchError(err => {
        if (err.status === 400) {
          this.router.navigate(['/login']);
          return throwError(() => err);
        }
        if (err.status === 401 && err.error?.error === 'SESSION_DISPLACED') {
          localStorage.clear();
          sessionStorage.clear();
          alert('Your session was closed because you logged in from another device.');
          this.router.navigate(['/login']);
        }
        return throwError(() => err);
      })
    );
  }
}
