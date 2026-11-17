import { Injectable } from '@angular/core';
import { HttpClient, HttpResponse } from '@angular/common/http';
import { BehaviorSubject, Observable, timer, of } from 'rxjs';
import { catchError, map, timeout } from 'rxjs/operators';
import { environment } from 'src/environments/environment';

@Injectable({
  providedIn: 'root'
})
export class NetworkService {
  private isOnlineSubject = new BehaviorSubject<boolean>(navigator.onLine);
  public isOnline$ = this.isOnlineSubject.asObservable();

  constructor(private http: HttpClient) {
    this.initializeNetworkMonitoring();
  }

  private initializeNetworkMonitoring(): void {
    // Listen to browser online/offline events
    window.addEventListener('online', () => this.updateNetworkStatus(true));
    window.addEventListener('offline', () => this.updateNetworkStatus(false));
    
    // Set initial status based on browser's navigator.onLine
    this.updateNetworkStatus(navigator.onLine);
  }

  private updateNetworkStatus(isOnline: boolean): void {
    if (this.isOnlineSubject.value !== isOnline) {
      console.log(`Network status changed: ${isOnline ? 'Online' : 'Offline'}`);
      this.isOnlineSubject.next(isOnline);
    }
  }

  private checkConnectivity(): Observable<boolean> {
    // Simple ping to the server with proper timeout handling
    return this.http.get(`${environment.apiUrl}live-health-check`, { 
      observe: 'response'
    }).pipe(
      timeout(5000), // 5 second timeout using RxJS operator
      map((response: any) => response.status === 200),
      catchError(() => {
        // If health check fails, try a simple head request to the base URL
        return this.http.head(environment.apiUrl, { 
          observe: 'response'
        }).pipe(
          timeout(5000),
          map(() => true),
          catchError(() => of(false)) // Return false if both requests fail
        );
      })
    );
  }

  public checkServerHealth(): Observable<boolean> {
    return this.checkConnectivity();
  }

  public getCurrentStatus(): boolean {
    return this.isOnlineSubject.value;
  }
}