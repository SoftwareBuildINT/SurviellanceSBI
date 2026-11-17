import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, throwError } from 'rxjs';
import { environment } from '../../environments/environment';
@Injectable({
  providedIn: 'root'
})
export class PasswordService {
  // private apiUrl = 'http://localhost:7668/api/password-expiry'; 
  private apiUrl = environment.apiUrl + 'password-expiry';
  //  private apiUrl = `${environment.apiUrl}password-expiry`;

  constructor(private http: HttpClient) {}

  getPasswordExpiry(): Observable<any> {
    const userId = localStorage.getItem('userId'); // 👈 get userId from localStorage

    if (!userId) {
      // handle missing userId gracefully
      return throwError(() => new Error('User ID not found in localStorage'));
    }

    return this.http.get<any>(`${this.apiUrl}/${userId}`);
  }
}
