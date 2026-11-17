import { Component, OnInit } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { timeout } from 'rxjs/operators';
import { environment } from '../../environments/environment';
import * as XLSX from 'xlsx';

interface VendorHealthData {
  vendor_name: string;
  vendor_id: number;
  online_count: number;
  offline_count: number;
  total_count: number;
  health_percentage: number;
  missing_in_db: any[];
  missing_in_api: any[];
  online_data: any[];
  offline_data: any[];
  api_data?: any[];
  db_data?: any[];
  error?: string;
  api_available?: boolean;
  api_error?: string | null;
  total_api_records: number;
  total_db_records: number;
  missing_in_api_count: number;
  missing_in_db_count: number;
}

interface HealthApiResponse {
  success: boolean;
  timestamp: string;
  cached?: boolean;
  cache_age_minutes?: number;
  cache_expires_in_minutes?: number;
  overall_summary: {
    total_vendors: number;
    total_atms?: number;
    total_matched: number;
    total_online: number;
    total_offline: number;
    overall_health_percentage: number;
    total_missing_in_api: number;
    total_missing_in_db: number;
    total_api_records: number;
    total_db_records: number;
    successful_vendors: number;
    failed_vendors: number;
  };
  vendor_results: VendorHealthData[];
}

@Component({
  selector: 'app-live-health',
  templateUrl: './live-health.component.html',
  styleUrls: ['./live-health.component.scss']
})
export class LiveHealthComponent implements OnInit {

  // Table data and state
  healthData: VendorHealthData[] = [];
  summaryData: any = null;
  cacheInfo: any = null;
  loading = false;

  // Modal state
  showModal = false;
  selectedVendor: VendorHealthData | null = null;
  modalType: 'db' | 'api' | 'all' | 'breakdown' = 'db';

  // Accordion state
  accordionSections = {
    matched: true,      // Open by default
    missingDB: false,
    missingAPI: false
  };

  constructor(private http: HttpClient) { }

  ngOnInit(): void {
    // Automatically load vendor health data on component initialization
    this.loadHealthData();
  }

  // Load health data from API
  loadHealthData(forceRefresh: boolean = false) {
    this.loading = true;
    this.healthData = [];
    this.summaryData = null;
    this.cacheInfo = null;

    console.log(forceRefresh ? 'Fetching fresh data...' : 'Loading vendor health data...');
    
    // Add refresh parameter if force refresh
    const url = forceRefresh 
      ? `${environment.apiUrl}live-health-check?refresh=true`
      : `${environment.apiUrl}live-health-check`;
    
    // Use longer timeout for this API as it fetches from multiple external sources
    this.http.get<HealthApiResponse>(url, {
      headers: { 'X-Skip-Interceptor-Timeout': 'true' }
    }).pipe(
      timeout(120000) // 2 minutes timeout for this specific request
    ).subscribe({
      next: (response) => {
        console.log('API Response:', response);
        if (response.success && response.vendor_results) {
          this.healthData = response.vendor_results;
          // Derive displayed aggregates from the visible vendor rows. This keeps
          // the cards consistent with the table and excludes failed APIs.
          const reportingVendors = this.healthData.filter(vendor => this.isVendorAvailable(vendor));
          const totalOnline = reportingVendors.reduce((sum, vendor) => sum + (Number(vendor.online_count) || 0), 0);
          const totalOffline = reportingVendors.reduce((sum, vendor) => sum + (Number(vendor.offline_count) || 0), 0);
          const totalMissingInApi = reportingVendors.reduce((sum, vendor) => sum + (Number(vendor.missing_in_api_count) || 0), 0);
          const totalAtms = reportingVendors.reduce((sum, vendor) => sum + (Number(vendor.total_count) || 0), 0);
          const knownStatusTotal = totalOnline + totalOffline;

          this.summaryData = {
            totalVendors: this.healthData.length,
            availableVendors: reportingVendors.length,
            failedVendors: this.healthData.length - reportingVendors.length,
            totalAtms,
            totalOnline,
            totalOffline,
            overallHealthPercentage: knownStatusTotal > 0 ? Math.round((totalOnline / knownStatusTotal) * 100) : 0,
            totalMissingInApi,
            totalMissingInDb: reportingVendors.reduce((sum, vendor) => sum + (Number(vendor.missing_in_db_count) || 0), 0)
          };

          this.cacheInfo = {
            cached: response.cached || false,
            cache_age_minutes: response.cache_age_minutes || 0,
            cache_expires_in_minutes: response.cache_expires_in_minutes || 0
          };
          
          console.log('Data loaded successfully:', {
            vendorCount: this.healthData.length,
            summaryData: this.summaryData,
            cacheInfo: this.cacheInfo
          });
        } else {
          console.error('API response indicates failure:', response);
        }
        this.loading = false;
      },
      error: (error) => {
        console.error('Error fetching health data:', error);
        this.loading = false;
      }
    });
  }

  isVendorAvailable(vendor: VendorHealthData): boolean {
    return vendor.api_available !== false && !vendor.api_error && !vendor.error;
  }

  // Refresh data bypassing cache
  refreshData() {
    this.loadHealthData(true);
  }

  // Get status badge class
  getStatusClass(status: string): string {
    switch (status?.toLowerCase()) {
      case 'online': return 'bg-success';
      case 'offline': return 'bg-danger';
      default: return 'bg-secondary';
    }
  }

  // Get percentage color class
  getPercentageClass(percentage: number): string {
    if (percentage >= 80) return 'text-success';
    if (percentage >= 60) return 'text-warning';
    return 'text-danger';
  }

  // Open modal to show missing ATM IDs or all ATMs
  openMissingModal(vendor: VendorHealthData, type: 'db' | 'api' | 'all') {
    this.selectedVendor = vendor;
    this.modalType = type;
    this.showModal = true;
    const count = type === 'db' ? vendor.missing_in_db?.length : 
                  type === 'api' ? vendor.missing_in_api?.length : 
                  vendor.total_count;
    console.log('Opening modal:', { vendor: vendor.vendor_name, type, count });
  }

  // Open breakdown modal to show categorized data
  openBreakdownModal(vendor: VendorHealthData) {
    this.selectedVendor = vendor;
    this.modalType = 'breakdown';
    this.showModal = true;
    console.log('Opening breakdown modal:', vendor.vendor_name);
  }

  // Close modal
  closeModal() {
    this.showModal = false;
    this.selectedVendor = null;
    // Reset accordion state
    this.accordionSections = {
      matched: true,
      missingDB: false,
      missingAPI: false
    };
  }

  // Toggle accordion section
  toggleAccordion(section: 'matched' | 'missingDB' | 'missingAPI') {
    this.accordionSections[section] = !this.accordionSections[section];
  }

  // Get data for modal based on type
  getModalData(): any[] {
    if (!this.selectedVendor) return [];
    
    if (this.modalType === 'db') {
      return this.selectedVendor.missing_in_db || [];
    } else if (this.modalType === 'api') {
      return this.selectedVendor.missing_in_api || [];
    } else {
      // Return all matched ATMs (online + offline)
      const allAtms = [
        ...(this.selectedVendor.online_data || []),
        ...(this.selectedVendor.offline_data || [])
      ];
      return allAtms;
    }
  }

  // Get matched ATMs for breakdown modal
  getMatchedAtms(): any[] {
    if (!this.selectedVendor) return [];
    return [
      ...(this.selectedVendor.online_data || []),
      ...(this.selectedVendor.offline_data || [])
    ];
  }

  // Download Excel for specific section
  downloadExcel(type: 'matched' | 'missing_db' | 'missing_api') {
    if (!this.selectedVendor) return;

    let data: any[] = [];
    let filename = '';

    switch (type) {
      case 'matched':
        data = this.getMatchedAtms();
        filename = `${this.selectedVendor.vendor_name}_Matched_ATMs_${new Date().toISOString().split('T')[0]}.xlsx`;
        break;
      case 'missing_db':
        data = this.selectedVendor.missing_in_db || [];
        filename = `${this.selectedVendor.vendor_name}_Missing_In_DB_${new Date().toISOString().split('T')[0]}.xlsx`;
        break;
      case 'missing_api':
        data = this.selectedVendor.missing_in_api || [];
        filename = `${this.selectedVendor.vendor_name}_Missing_In_API_${new Date().toISOString().split('T')[0]}.xlsx`;
        break;
    }

    if (data.length === 0) {
      alert('No data to download');
      return;
    }

    // Transform data for Excel
    const excelData = data.map((atm, index) => ({
      'S.No': index + 1,
      'ATM ID': atm.atm_id || 'N/A',
      'Site Name': atm.unit_name || 'N/A',
      'City': atm.city || 'N/A',
      'State': atm.state || 'N/A',
      'Status': atm.site_status || 'N/A'
    }));

    // Create worksheet and workbook
    const ws: XLSX.WorkSheet = XLSX.utils.json_to_sheet(excelData);
    const wb: XLSX.WorkBook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'ATM Data');

    // Save file
    XLSX.writeFile(wb, filename);
  }
}
