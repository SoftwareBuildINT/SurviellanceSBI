import { Injectable } from '@angular/core';
import { CanActivate, Router, ActivatedRouteSnapshot, UrlTree } from '@angular/router';
import { Observable } from 'rxjs';
@Injectable({
  providedIn: 'root'
})
export class AuthGuard implements CanActivate {

  constructor(private router: Router) { }

  /** Decode a JWT without verifying the signature (signature is verified server-side).
   *  Returns the payload object or null if the token is malformed. */
  private decodeJwt(token: string): any {
    try {
      const parts = token.split('.');
      if (parts.length !== 3) return null;
      return JSON.parse(atob(parts[1]));
    } catch {
      return null;
    }
  }

  /** Returns true only when the token is a structurally valid JWT whose
   *  payload contains verified: true and has not expired. */
  private isVerifiedToken(token: string | null): boolean {
    if (!token) return false;
    const payload = this.decodeJwt(token);
    if (!payload) return false;
    // Must carry the OTP-verified flag that the backend sets after /verify-otp
    if (payload.verified !== true) return false;
    // Must not be expired (exp is seconds since epoch)
    if (payload.exp && Date.now() / 1000 > payload.exp) return false;
    return true;
  }

  canActivate(route: ActivatedRouteSnapshot): Observable<boolean | UrlTree> | Promise<boolean | UrlTree> | boolean | UrlTree {
    const finalToken = localStorage.getItem('token');
    const tempToken  = localStorage.getItem('tempToken');

    // Only allow access when the token is a verified JWT (otpVerified: true)
    if (this.isVerifiedToken(finalToken)) {
      return this.checkRoleAndAllow(route);
    }

    // If the user just completed the password step, send them to OTP
    if (tempToken) {
      this.router.navigate(['/otp']);
      return false;
    }

    // Not logged in at all
    this.router.navigate(['/login']);
    return false;
  }

  private checkRoleAndAllow(route: ActivatedRouteSnapshot): boolean {
    // Role from localStorage (set during login)
    const storedRoleId = localStorage.getItem('roleId');
    const roleId = storedRoleId ? Number(storedRoleId) : 0;

    const path = route.routeConfig?.path || '';

    // 🔒 Live Health Access Control - Admin only (role_id = 1)
    if (path === 'live-health' && roleId !== 1) {
      this.router.navigate(['/dashboard']);
      return false;
    }

    // Admin-only routes: usermanagement, adduser, users/edit/:id, addsite, editsite
    if (
      (path === 'usermanagement' ||
        path === 'adduser' ||
        path === 'addsite' ||
        path.startsWith('editsite') ||
        path.startsWith('users/edit')) &&
      roleId !== 1
    ) {
      // Not authorized for admin pages — send them to dashboard
      this.router.navigate(['/dashboard']);
      return false;
    }

    return true;
  }
}
