import { Injectable } from '@angular/core';
import { HttpClient, HttpHeaders, HttpErrorResponse } from '@angular/common/http';
import { Observable, throwError } from 'rxjs';
import { timeout } from 'rxjs/operators';
import { catchError, map } from 'rxjs/operators';
import { environment } from 'src/environments/environment';

@Injectable({
  providedIn: 'root',
})

export class DataService {
  private loginUrl = `${environment.apiUrl}login`; // Login API URL

  constructor(private http: HttpClient) { }

  // Method to log in and store the token
  login(payload: { EmailId: string; password: string }): Observable<any> {
    const headers = new HttpHeaders({
      'Content-Type': 'application/json',
    });

    return this.http.post<any>(this.loginUrl, payload, { headers }).pipe(
      timeout(20000)
    );
  }

  getLhoList(lhoId: string): Observable<any> {
    const apiUrl = `${environment.apiUrl}lho-list?lho_id=${lhoId}`;
    return this.http.get(apiUrl, { responseType: 'json' });
  }

  // Method to add a new ATM
  addATM(atmData: { atmId: string; lho_id: string }): Observable<any> {
    const apiUrl = `${environment.apiUrl}add-atm`;
    return this.http.post(apiUrl, atmData, { responseType: 'json' });
  }

  // Method to create the authorization header
  private getAuthHeaders(): HttpHeaders {
    const token = localStorage.getItem('token');
    let headers = new HttpHeaders({
      'Content-Type': 'application/json',
    });

    if (token) {
      headers = headers.set('Authorization', `Bearer ${token}`);
    }

    return headers;
  }

  // Method to check if the user is authenticated
  isAuthenticated(): boolean {
    const token = localStorage.getItem('token');
    return !!token; // Return true if token exists, false otherwise
  }
  getPasswordExpiry(userId: string) {
    return this.http.get<any>(
      `${environment.apiUrl}api/password-expiry/${userId}`
    );
  }

  logout(): Observable<any> {
    const headers = this.getAuthHeaders();
    return this.http.post<any>(`${environment.apiUrl}logout`, {}, { headers });
  }


  // Keep this method for other APIs that might need generic error handling
  private handleError(error: HttpErrorResponse): Observable<never> {
    console.error('An error occurred:', error);

    let errorMessage = 'An unknown error occurred!';
    if (error.error instanceof ErrorEvent) {
      // A client-side or network error occurred
      errorMessage = `Error: ${error.error.message}`;
    } else {
      // The backend returned an unsuccessful response code
      switch (error.status) {
        case 401:
          errorMessage = 'Unauthorized: Invalid credentials or token';
          break;
        case 404:
          errorMessage = 'Not Found: The requested resource could not be found';
          break;
        case 500:
          errorMessage = 'Server Error: Please try again later';
          break;
        default:
          errorMessage = error.message || 'Server error';
          break;
      }
    }

    console.error('Error details:', errorMessage);
    return throwError(errorMessage);
  }
}