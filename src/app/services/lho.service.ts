import { HttpClient } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import { environment } from 'src/environments/environment';

/* -------------------- INTERFACES -------------------- */

export interface LhoDetail {
  lho_id: number;
  lho_name: string;
  total_locations: number;
  onlineCount: number;
  offlineCount: number;
  percentage: number;
}

export interface DashboardSnapshot {
  totalLocations: number;
  totalOnline: number;
  totalOffline: number;
  totalPercentage: number;
  lhoDetails: LhoDetail[];
}

@Injectable({
  providedIn: 'root'
})
export class LhoService {

  private baseUrl = environment.apiUrl; // ✅ use env

  constructor(private http: HttpClient) {}

  /* -------------------- DASHBOARD -------------------- */

  getDashboardSnapshot(lhoId?: number): Observable<DashboardSnapshot> {
    let url = `${this.baseUrl}dashboard-snapshot`;

    if (lhoId) {
      url += `?lho_id=${lhoId}`;
    }

    return this.http.get<DashboardSnapshot>(url);
  }

  /* -------------------- (FUTURE) ATM DETAILS -------------------- */

  // Will be implemented after backend ATM snapshot API exists
  getLhoAtmDetails(lhoId: number): Observable<any[]> {
    return this.http.get<any[]>(
      `${this.baseUrl}lho-atm-snapshot?lho_id=${lhoId}`
    );
  }
  getDashboardSummary() {
  return this.http.get<{
    snapshotTime: string;
    totalLocations: number;
    totalOnline: number;
    totalOffline: number;
  }>(`${this.baseUrl}dashboard-summary`);
}
}
