import { Component, OnInit, OnDestroy } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Router } from '@angular/router';
import * as XLSX from 'xlsx';
import { saveAs } from 'file-saver';
import { environment } from '../../environments/environment';
import { Subject } from 'rxjs';
import { debounceTime, distinctUntilChanged } from 'rxjs/operators';

interface HealthRow {
  LHO: string;
  atm_latest?: string;
  atm_1?: string;
  atm_2?: string;
  atm_3?: string;
  atm_4?: string;
  atm_5?: string;
  address: string;
  state: string;
  city: string;
  pincode: number;
  vendor: string;
  vendorSource: string;
  status: string;
  lastCommunication: string;
  ageing: string;
}

@Component({
  selector: 'app-healthstatus',
  templateUrl: './healthstatus.component.html',
  styleUrls: ['./healthstatus.component.scss']
})
export class HealthStatusComponent implements OnInit, OnDestroy {

  paginatedData: HealthRow[] = [];

  searchText = '';
  loading = true;

  currentPage = 1;
  pageSize = 20;
  totalRecords = 0;
  totalOnline = 0;
  totalOffline = 0;

  get totalPages(): number {
    return Math.ceil(this.totalRecords / this.pageSize);
  }

  isLiveHealthUser = false;

  private searchSubject = new Subject<string>();

  constructor(private http: HttpClient, private router: Router) {}

  ngOnInit() {
    const userId = localStorage.getItem('userId');
    this.isLiveHealthUser = userId === '129';

    this.searchSubject.pipe(
      debounceTime(400),
      distinctUntilChanged()
    ).subscribe(() => {
      this.currentPage = 1;
      this.loadHealthData();
    });

    this.loadHealthData();
  }

  ngOnDestroy() {
    this.searchSubject.complete();
  }

  onSearchChange() {
    this.searchSubject.next(this.searchText);
  }

  loadHealthData() {
    this.loading = true;

    const params = new URLSearchParams({
      page: String(this.currentPage),
      pageSize: String(this.pageSize),
      search: this.searchText
    });

    this.http.get<any>(`${environment.apiUrl}get-atm-details?${params}`).subscribe({
      next: (response) => {
        if (!response || !response.data) {
          this.loading = false;
          return;
        }

        this.paginatedData = response.data.map((row: any) => ({
          ...row,
          lastCommunication: this.displayLastCommunication(row.lastCommunication),
          ageing: String(row.status || '').toUpperCase() === 'ONLINE'
            ? '0 days'
            : (row.ageing || this.calculateAgeing(row.lastCommunication)),
          vendorSource: row.vendorSource || '-',
          status: row.status || '-'
        }));

        this.totalRecords = response.total;
        this.totalOnline  = response.totalOnline  || 0;
        this.totalOffline = response.totalOffline || 0;
        this.loading = false;
      },
      error: (err) => {
        console.error('Error loading health data:', err);
        this.loading = false;
      }
    });
  }

  calculateAgeing(lastCommunication: string): string {
    const last = this.parseDateTime(lastCommunication);
    if (!last || isNaN(last.getTime())) return '-';
    const now = new Date();
    const lastDay = Date.UTC(last.getFullYear(), last.getMonth(), last.getDate());
    const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
    const days = Math.max(0, Math.round((today - lastDay) / 86400000));
    return `${days} days`;
  }

  parseDateTime(dateStr: any): Date | null {
    if (!dateStr || dateStr === '-') return null;
    if (dateStr instanceof Date) return dateStr;
    if (typeof dateStr === 'number') {
      return new Date(dateStr < 100000000000 ? dateStr * 1000 : dateStr);
    }
    dateStr = String(dateStr).trim();
    if (/^\d{2}-\d{2}-\d{4}/.test(dateStr)) {
      const [datePart, timePart] = dateStr.split(' ');
      const [dd, mm, yyyy] = datePart.split('-');
      return new Date(`${yyyy}-${mm}-${dd}T${timePart}`);
    }
    if (/^\d{4}-\d{2}-\d{2}/.test(dateStr)) {
      return new Date(dateStr.replace(' ', 'T'));
    }
    const parsed = new Date(dateStr);
    return isNaN(parsed.getTime()) ? null : parsed;
  }

  formatDateTime(dateStr: string): string {
    const date = this.parseDateTime(dateStr);
    if (!date || isNaN(date.getTime())) return '-';
    const pad = (n: number) => n.toString().padStart(2, '0');
    return `${pad(date.getDate())}-${pad(date.getMonth() + 1)}-${date.getFullYear()} ` +
           `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  }

  displayLastCommunication(value: any): string {
    if (value === null || value === undefined || value === '' || value === '-') return '-';
    const formatted = this.formatDateTime(String(value));
    // Do not hide a vendor value merely because its format is unfamiliar.
    return formatted === '-' ? String(value) : formatted;
  }

  changePage(page: number) {
    if (page < 1 || page > this.totalPages) return;
    this.currentPage = page;
    this.loadHealthData();
  }

  goToFirst() { this.changePage(1); }
  goToLast()  { this.changePage(this.totalPages); }
  goToPrev()  { this.changePage(this.currentPage - 1); }
  goToNext()  { this.changePage(this.currentPage + 1); }

  exportToExcel() {
    const params = new URLSearchParams({ export: 'true', search: this.searchText });

    this.http.get<any>(`${environment.apiUrl}get-atm-details?${params}`).subscribe({
      next: (response) => {
        const totalLocations = response.total        || 0;
        const totalOnline    = response.totalOnline  || 0;
        const totalOffline   = response.totalOffline || 0;

        const rows = (response.data || []).map((row: any) => ({
          ...row,
          lastCommunication: this.displayLastCommunication(row.lastCommunication),
          ageing: String(row.status || '').toUpperCase() === 'ONLINE'
            ? '0 days'
            : (row.ageing || this.calculateAgeing(row.lastCommunication)),
          vendorSource: row.vendorSource || '-',
          status: row.status || '-'
        }));

        /* Summary rows at top — same counts as the dashboard */
        const summaryRows = [
          { 'Sr No': 'Total Locations', 'LHO': totalLocations, 'ATM Latest': '', 'ATM 1': '', 'ATM 2': '', 'ATM 3': '', 'ATM 4': '', 'ATM 5': '', 'Address': '', 'State': '', 'City': '', 'Pincode': '', 'Vendor': '', 'Vendor Source': '', 'Status': '', 'Last Communication': '', 'Ageing': '' },
          { 'Sr No': 'Online',          'LHO': totalOnline,    'ATM Latest': '', 'ATM 1': '', 'ATM 2': '', 'ATM 3': '', 'ATM 4': '', 'ATM 5': '', 'Address': '', 'State': '', 'City': '', 'Pincode': '', 'Vendor': '', 'Vendor Source': '', 'Status': '', 'Last Communication': '', 'Ageing': '' },
          { 'Sr No': 'Offline',         'LHO': totalOffline,   'ATM Latest': '', 'ATM 1': '', 'ATM 2': '', 'ATM 3': '', 'ATM 4': '', 'ATM 5': '', 'Address': '', 'State': '', 'City': '', 'Pincode': '', 'Vendor': '', 'Vendor Source': '', 'Status': '', 'Last Communication': '', 'Ageing': '' },
          { 'Sr No': '', 'LHO': '', 'ATM Latest': '', 'ATM 1': '', 'ATM 2': '', 'ATM 3': '', 'ATM 4': '', 'ATM 5': '', 'Address': '', 'State': '', 'City': '', 'Pincode': '', 'Vendor': '', 'Vendor Source': '', 'Status': '', 'Last Communication': '', 'Ageing': '' }
        ];

        const excelData = rows.map((item: HealthRow, index: number) => ({
          'Sr No': index + 1,
          'LHO': item.LHO,
          'ATM Latest': item.atm_latest || '-',
          'ATM 1': item.atm_1 || '-',
          'ATM 2': item.atm_2 || '-',
          'ATM 3': item.atm_3 || '-',
          'ATM 4': item.atm_4 || '-',
          'ATM 5': item.atm_5 || '-',
          'Address': item.address,
          'State': item.state,
          'City': item.city,
          'Pincode': item.pincode,
          'Vendor': item.vendor,
          'Vendor Source': item.vendorSource,
          'Status': item.status,
          'Last Communication': item.lastCommunication,
          'Ageing': item.ageing
        }));

        const worksheet = XLSX.utils.json_to_sheet([...summaryRows, ...excelData]);
        const workbook = { Sheets: { 'Health Status': worksheet }, SheetNames: ['Health Status'] };
        const buffer = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' });
        saveAs(new Blob([buffer]), 'HealthStatusReport.xlsx');
      },
      error: (err) => console.error('Export failed:', err)
    });
  }

  navigateToLiveHealth() {
    this.router.navigate(['/live-health']);
  }
}
