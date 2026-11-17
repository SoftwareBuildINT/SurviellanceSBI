import { Injectable } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Observable, throwError } from 'rxjs';
import { catchError, timeout } from 'rxjs/operators';
import { environment } from 'src/environments/environment';

@Injectable({
  providedIn: 'root'
})
export class AuthService {
  // private apiUrl = 'http://localhost:7668'; 
  private apiUrl = environment.apiUrl; 
  

  constructor(private http: HttpClient) { }

  login(email: string, password: string): Observable<any> {
    return this.http.post(`${this.apiUrl}login`, { EmailId: email, password }).pipe(
      timeout(30000),
      catchError(this.handleError)
    );
  }
  changePassword(oldPassword: string, newPassword: string, userId: string): Observable<any> {
    // Send oldPassword, newPassword, and userId in the POST request
    return this.http.post(`${this.apiUrl}change-password`, {
      oldPassword,
      newPassword,
      confirmPassword: newPassword,  // Ensure confirmPassword is sent as well for validation
      userId,
    }).pipe(
      timeout(30000),
      catchError(this.handleError)
    );
  }
  verifyOtp(email: string, otp: string): Observable<any> {
    return this.http.post(`${this.apiUrl}verify-otp`, {
      EmailId: email,
      otp: Number(otp)
    }).pipe(
      timeout(30000),
      catchError(this.handleError)
    );
  }

  private handleError = (error: HttpErrorResponse): Observable<never> => {
    let errorMessage = 'An unknown error occurred';
    
    if (error.error instanceof ErrorEvent) {
      // Client-side error
      errorMessage = `Client Error: ${error.error.message}`;
    } else if (error.status === 0) {
      // Network error or CORS issue
      errorMessage = 'Network error - please check your connection and try again';
    } else {
      // Server-side error
      errorMessage = `Server Error: ${error.status} - ${error.message}`;
    }
    
    console.error('HTTP Error:', errorMessage, error);
    return throwError(() => new Error(errorMessage));
  }

}
