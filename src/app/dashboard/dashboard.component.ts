import { Component, OnInit, OnDestroy } from '@angular/core';
import { Router } from '@angular/router';
import { HttpClient } from '@angular/common/http';
import { environment } from 'src/environments/environment';
import * as XLSX from 'xlsx';
import { saveAs } from 'file-saver';
import { interval, Subscription } from 'rxjs';
import { LhoService, DashboardSnapshot } from '../services/lho.service';

@Component({
  selector: 'app-dashboard',
  templateUrl: './dashboard.component.html',
  styleUrls: ['./dashboard.component.scss']
})

export class DashboardComponent implements OnInit, OnDestroy {

  /* ---------------- UI FLAGS ---------------- */
  loading = true;
  loadingTotals = true;   // ✅ REQUIRED by HTML
  liveDataRefreshing = true;
  liveDataError = false;
  hasLiveLhoDetails = false;
  liveRequestPending = false;
  showModal = false;

  /* ---------------- USER ---------------- */
  userRole: number | null = null;

  /* ---------------- TOTALS ---------------- */
  totalLocations = 0;
  totalOnline = 0;
  totalOffline = 0;
  totalPercentage = 0;
  exportingCard: 'total' | 'online' | 'offline' | null = null;
  openCardMenu: 'total' | 'online' | 'offline' | null = null;

  /* ---------------- LHO DATA ---------------- */
  lhoList: any[] = [];
  filteredLhoList: any[] = [];

  /* ---------------- ATM SEARCH ---------------- */
  searchTerm = '';
  atmList: string[] = [];
  filteredAtmList: string[] = [];

  /* ---------------- MODAL ---------------- */
  selectedLho: any = null;
  lhoName = '';

  /* ---------------- AUTO REFRESH ---------------- */
  refreshSub!: Subscription;

  constructor(
    private router: Router,
    private http: HttpClient,
    private lhoService: LhoService
  ) { }

  /* ---------------- INIT ---------------- */

  ngOnInit(): void {
    this.getUserRole();
    this.fetchAtmList();
    // Render the latest saved summary immediately, then replace it with the
    // vendor-backed result when the full live-status request completes.
    this.loadDashboardSnapshot();
    this.loadLhoDetails();
    // UI auto-refresh (optional)
    this.refreshSub = interval(300000).subscribe(() => {
      this.loadLhoDetails();

    });
  }

  ngOnDestroy(): void {
    this.refreshSub?.unsubscribe();
  }
  fetchDashboardTotals(): void {
    this.loadingTotals = true;

    const lhoIdStr = localStorage.getItem('lho_id');
    // If user has single LHO id, request server-filtered totals. Otherwise fall back to global totals.
    const lhoId = lhoIdStr && !lhoIdStr.includes(',') && !lhoIdStr.trim().startsWith('[') && lhoIdStr !== 'null' ? Number(lhoIdStr) : undefined;

    this.lhoService.getDashboardSnapshot(lhoId).subscribe({
      next: (res: DashboardSnapshot) => {
        this.totalLocations = res.totalLocations;
        this.totalOnline = res.totalOnline;
        this.totalOffline = res.totalOffline;
        this.loadingTotals = false;
      },
      error: (err) => {
        console.error('Dashboard summary error', err);
        this.loadingTotals = false;
      }
    });
  }
  /* ---------------- LHO DETAILS (NEW API) ---------------- */
  loadLhoDetails(): void {
    if (this.liveRequestPending) return;
    this.liveRequestPending = true;
    this.liveDataRefreshing = true;
    this.liveDataError = false;
    if (!this.lhoList.length) {
      this.loading = true;
      this.loadingTotals = true;
    }

    // Use the same live vendor-backed data source as Health Status. The
    // dashboard snapshot endpoint is intentionally not used here because it
    // may contain the previous cron run while Health Status is live.
    const url = `${environment.apiUrl}get-atm-details?export=true`;

    this.http.get<any>(url).subscribe({
      next: (res) => {
        const rows = res.data || [];

        // Respect user's LHO access from localStorage (single id or comma-separated list or JSON array)
        const lhoIdStr = localStorage.getItem('lho_id');
        let allowedLhoIds: number[] | null = null;

        if (lhoIdStr && lhoIdStr !== 'null') {
          try {
            if (lhoIdStr.trim().startsWith('[')) {
              const parsed = JSON.parse(lhoIdStr);
              if (Array.isArray(parsed)) {
                allowedLhoIds = parsed.map((x: any) => Number(x));
              }
            } else if (lhoIdStr.includes(',')) {
              allowedLhoIds = lhoIdStr.split(',').map(s => Number(s.trim()));
            } else {
              const v = Number(lhoIdStr);
              if (!Number.isNaN(v)) allowedLhoIds = [v];
            }
          } catch (e) {
            const v = Number(lhoIdStr);
            if (!Number.isNaN(v)) allowedLhoIds = [v];
          }
        }

        // Filter rows if user has restricted access
        // Older backend workers may not yet include lho_id. In that case keep
        // all rows and group by LHO name; do not accidentally hide every LHO.
        const hasLhoIds = rows.some((r: any) => Number(r.lho_id) > 0);
        const visibleRows = allowedLhoIds && hasLhoIds
          ? rows.filter((r: any) => allowedLhoIds!.includes(Number(r.lho_id)))
          : rows;

        // Group the live Health Status rows by LHO so both screens use the
        // exact same vendor status result and inclusion rules.
        const grouped = new Map<string, any>();
        visibleRows.forEach((r: any) => {
          const id = Number(r.lho_id || 0);
          const name = r.LHO || r.lho_name || 'N/A';
          const key = `${id}|${name}`;
          if (!grouped.has(key)) {
            grouped.set(key, { LHO_Name: name, lho_id: id, total_locations: 0, onlineCount: 0, offlineCount: 0 });
          }
          const lho = grouped.get(key);
          lho.total_locations++;
          String(r.status || '').toUpperCase() === 'ONLINE' ? lho.onlineCount++ : lho.offlineCount++;
        });
        this.lhoList = Array.from(grouped.values()).map((lho: any) => ({
          ...lho,
          percentage: lho.total_locations > 0 ? Number(((lho.onlineCount / lho.total_locations) * 100).toFixed(2)) : 0
        }));

        // Sort alphabetically
        this.lhoList.sort((a, b) => a.LHO_Name.localeCompare(b.LHO_Name));

        // Compute totals from visible rows
        // Calculate totals after LHO access filtering so restricted users see
        // counts only for locations they are allowed to view.
        this.totalLocations = this.lhoList.reduce((acc, l) => acc + (l.total_locations || 0), 0);
        this.totalOnline = this.lhoList.reduce((acc, l) => acc + (l.onlineCount || 0), 0);
        this.totalOffline = this.lhoList.reduce((acc, l) => acc + (l.offlineCount || 0), 0);
        this.totalPercentage = this.totalLocations > 0 ? Number(((this.totalOnline / this.totalLocations) * 100).toFixed(2)) : 0;

        this.filteredLhoList = [...this.lhoList];
        this.hasLiveLhoDetails = true;
        this.liveRequestPending = false;
        this.liveDataRefreshing = false;
        this.liveDataError = false;
        this.loading = false;
        this.loadingTotals = false;
      },
      error: (err) => {
        console.error('Failed to load LHO details', err);
        this.liveRequestPending = false;
        this.liveDataRefreshing = false;
        this.liveDataError = true;
        if (!this.lhoList.length) {
          this.loading = false;
          this.loadingTotals = false;
        }
      }
    });
  }
  /* ---------------- USER ---------------- */

  getUserRole(): void {
    const role = localStorage.getItem('roleId');
    this.userRole = role ? Number(role) : null;
  }

  /* ---------------- DASHBOARD SNAPSHOT ---------------- */
  // loadDashboardTotals(): void {
  //   this.loadingTotals = true;

  //   // Optional: filter by LHO if stored
  //   const lhoIdStr = localStorage.getItem('lho_id');
  //   const lhoId = lhoIdStr ? Number(lhoIdStr) : undefined;

  //   this.lhoService.getDashboardSnapshot(lhoId).subscribe({
  //     next: (res: DashboardSnapshot) => {
  //       this.totalLocations = res.totalLocations;
  //       this.totalOnline = res.totalOnline;
  //       this.totalOffline = res.totalOffline;

  //       this.loadingTotals = false;
  //     },
  //     error: (err) => {
  //       console.error('Failed to load dashboard snapshot', err);
  //       this.loadingTotals = false;
  //     }
  //   });
  // }
  loadDashboardSnapshot(): void {
    const lhoId = localStorage.getItem('lho_id');
    let url = `${environment.apiUrl}dashboard-snapshot`;

    if (lhoId && lhoId !== 'null') {
      url += `?lho_id=${lhoId}`;
    }

    this.http.get<any>(url).subscribe({
      next: (res) => {
        // Never let a slower snapshot overwrite the newer vendor response.
        if (this.hasLiveLhoDetails) return;
        this.totalLocations = Number(res.totalLocations || 0);
        this.totalOnline = Number(res.totalOnline || 0);
        this.totalOffline = Number(res.totalOffline || 0);
        this.totalPercentage = Number(res.totalPercentage || 0);

        const allowedLhoIds = this.getAllowedLhoIds();
        const snapshotRows = res.lhoDetails || [];
        const hasLhoIds = snapshotRows.some((l: any) => Number(l.lho_id) > 0);
        const visibleSnapshotRows = allowedLhoIds && hasLhoIds
          ? snapshotRows.filter((l: any) => allowedLhoIds.includes(Number(l.lho_id)))
          : snapshotRows;

        this.lhoList = visibleSnapshotRows.map((l: any) => ({
          LHO_Name: l.lho_name,
          lho_id: l.lho_id,
          total_locations: Number(l.total_locations),
          onlineCount: Number(l.onlineCount ?? l.online_count),
          offlineCount: Number(l.offlineCount ?? l.offline_count),
          percentage: Number(l.percentage || 0)
        }));

        if (allowedLhoIds && hasLhoIds) {
          this.totalLocations = this.lhoList.reduce((sum, l) => sum + l.total_locations, 0);
          this.totalOnline = this.lhoList.reduce((sum, l) => sum + l.onlineCount, 0);
          this.totalOffline = this.lhoList.reduce((sum, l) => sum + l.offlineCount, 0);
          this.totalPercentage = this.totalLocations
            ? Number(((this.totalOnline / this.totalLocations) * 100).toFixed(2))
            : 0;
        }

        this.lhoList.sort((a, b) =>
          a.LHO_Name.localeCompare(b.LHO_Name)
        );

        this.filteredLhoList = [...this.lhoList];
        if (this.lhoList.length) {
          this.loading = false;
          this.loadingTotals = false;
        }
      },
      error: (err) => {
        console.error('Dashboard snapshot error', err);
      }
    });
  }

  private getAllowedLhoIds(): number[] | null {
    const raw = localStorage.getItem('lho_id');
    if (!raw || raw === 'null') return null;

    try {
      const values = raw.trim().startsWith('[')
        ? JSON.parse(raw)
        : raw.includes(',') ? raw.split(',') : [raw];
      const ids = (Array.isArray(values) ? values : [values])
        .map((value: any) => Number(value))
        .filter((value: number) => Number.isFinite(value));
      return ids.length ? ids : null;
    } catch {
      const id = Number(raw);
      return Number.isFinite(id) ? [id] : null;
    }
  }

  /* ---------------- ATM SEARCH ---------------- */

  fetchAtmList(): void {
    this.http.get<any>(`${environment.apiUrl}atm-list`).subscribe({
      next: (res) => {
        console.log('ATM List Response:', res);
        this.atmList =
          res?.atm_list_new3 ||
          res?.atm_list_test2 ||
          res?.atm_list ||
          res?.data ||
          (Array.isArray(res) ? res : []);
        console.log('ATM List loaded:', this.atmList.length, 'items');
      },
      error: (err) => {
        console.error('Error fetching ATM list:', err);
        this.atmList = [];
      }
    });
  }

  filterAtmList(): void {
    const term = this.searchTerm.trim().toLowerCase();

    if (!term) {
      this.filteredAtmList = [];
      return;
    }

    this.filteredAtmList = this.atmList.filter(atm =>
      atm.toLowerCase().includes(term)
    );

    if (this.filteredAtmList.length === 0) {
      this.filteredAtmList = ['No Record Found'];
    }
  }

  selectAtm(atmId: string): void {
    if (atmId === 'No Record Found') return;

    this.router.navigate(['/liveview'], {
      queryParams: { atmId }
    });
  }

  /* ---------------- NAVIGATION ---------------- */

  navigateToSiteDetails(lho: any): void {
    this.router.navigate(['/sidedetails'], {
      queryParams: { lho_id: lho.lho_id, lho_name: lho.LHO_Name }
    });
  }

  /* ---------------- EXCEL ---------------- */

  downloadExcel(): void {
    const data = this.filteredLhoList.map(l => ({
      LHO: l.LHO_Name,
      'Total Locations': l.total_locations,
      Online: l.onlineCount,
      Offline: l.offlineCount,
      Percentage: `${l.percentage}%`
    }));

    const ws = XLSX.utils.json_to_sheet(data);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Dashboard');

    const buffer = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
    saveAs(new Blob([buffer]), 'LHO_Dashboard.xlsx');
  }

  downloadLocationExcel(type: 'total' | 'online' | 'offline'): void {
    if (this.exportingCard) return;

    this.openCardMenu = null;
    this.exportingCard = type;
    const params = new URLSearchParams({ export: 'true' });

    this.http.get<any>(`${environment.apiUrl}get-atm-details?${params}`).subscribe({
      next: (response) => {
        const visibleLhos = new Set(
          this.lhoList.map(lho => String(lho.LHO_Name || '').trim().toUpperCase())
        );

        let rows = (response?.data || []).filter((row: any) =>
          visibleLhos.has(String(row.LHO || '').trim().toUpperCase())
        );

        if (type !== 'total') {
          rows = rows.filter((row: any) =>
            String(row.status || '').trim().toUpperCase() === type.toUpperCase()
          );
        }

        const excelData = rows.map((row: any, index: number) => ({
          'Sr No': index + 1,
          'LHO': row.LHO || '-',
          'ATM Latest': row.atm_latest || '-',
          'ATM 1': row.atm_1 || '-',
          'ATM 2': row.atm_2 || '-',
          'ATM 3': row.atm_3 || '-',
          'ATM 4': row.atm_4 || '-',
          'ATM 5': row.atm_5 || '-',
          'Address': row.address || '-',
          'State': row.state || '-',
          'City': row.city || '-',
          'Pincode': row.pincode ?? '',
          'Vendor': row.vendor || '-',
          'Vendor Source': row.vendorSource || '-',
          'Status': row.status || '-',
          'Last Communication': row.lastCommunication || '-',
          'Ageing': row.ageing || '-'
        }));

        const label = type === 'total' ? 'Total Locations' :
          type === 'online' ? 'Online Locations' : 'Offline Locations';
        const worksheet = XLSX.utils.json_to_sheet(excelData);
        worksheet['!autofilter'] = { ref: worksheet['!ref'] || 'A1:R1' };

        const workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(workbook, worksheet, label.substring(0, 31));
        const buffer = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' });
        const date = new Date().toISOString().split('T')[0];
        saveAs(new Blob([buffer]), `${label.replace(/ /g, '_')}_${date}.xlsx`);
        this.exportingCard = null;
      },
      error: (err) => {
        console.error(`${type} locations export failed:`, err);
        alert('Unable to download the location data. Please try again.');
        this.exportingCard = null;
      }
    });
  }

  toggleCardMenu(type: 'total' | 'online' | 'offline', event: Event): void {
    event.stopPropagation();
    this.openCardMenu = this.openCardMenu === type ? null : type;
  }

  /* ---------------- MODAL ACTIONS ---------------- */

  openModal(lho: any = null): void {
    this.selectedLho = lho;
    this.lhoName = lho?.LHO_Name || '';
    this.showModal = true;
  }

  closeModal(): void {
    this.showModal = false;
    this.selectedLho = null;
    this.lhoName = '';
  }

  clearInput(): void {
    this.lhoName = '';
  }

  saveLho(): void {
    if (!this.lhoName.trim()) {
      alert('Please enter a valid LHO Name');
      return;
    }

    if (this.selectedLho) {
      this.http.put(
        `${environment.apiUrl}update-lho/${this.selectedLho.lho_id}`,
        { lho_name: this.lhoName }
      ).subscribe(() => {
        alert('LHO updated successfully');
        this.closeModal();
        this.loadLhoDetails();
      });
    } else {
      this.http.post(
        `${environment.apiUrl}add-lho`,
        { lho_name: this.lhoName }
      ).subscribe(() => {
        alert('LHO added successfully');
        this.closeModal();
        this.loadLhoDetails();
      });
    }
  }

  deleteLho(lho: any): void {
    if (!confirm(`Delete ${lho.LHO_Name}?`)) return;

    const userId = localStorage.getItem('userId');

    this.http.post(
      `${environment.apiUrl}delete-lho/${lho.lho_id}`,
      { deleted_by: userId }
    ).subscribe(() => {
      alert('LHO deleted');
      // Refresh list from server to ensure consistency
      this.loadLhoDetails();
    });
  }
}
