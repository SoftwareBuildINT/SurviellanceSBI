import { Component, OnInit, ViewChild, ElementRef } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import * as XLSX from 'xlsx';
import { saveAs } from 'file-saver';
import Swal from 'sweetalert2';
import { Router } from '@angular/router';
import { environment } from 'src/environments/environment';


interface Site {
  atm_latest: string;
  atm_1?: string;
  atm_2?: string;
  atm_3?: string;
  atm_4?: string;
  atm_5?: string;

  lho_id: number;
  lho_name?: string;

  vendor: number;
  vendor_name?: string;

  site_address: string;
  city: string;
  state: string;
  pincode: number;

  is_active: boolean;
  expanded?: boolean;
}

@Component({
  selector: 'app-sitemaster',
  templateUrl: './sitemaster.component.html',
  styleUrls: ['./sitemaster.component.scss']
})
export class SitemasterComponent implements OnInit {
  sites: Site[] = [];
  searchText: string = '';
  userRole: number | null = null;

  constructor(
    private http: HttpClient,
    private router: Router   // ✅ ADD THIS
  ) { }

  ngOnInit(): void {
    this.loadSites();
    this.getUserRole();
  }
  getUserRole(): void {
    const role = localStorage.getItem('roleId');
    this.userRole = role ? parseInt(role, 10) : null; // convert to number
    if (!this.userRole) {
      console.error('Role ID is not set in localStorage');
    }
  }
  isLoadingTable: boolean = true;
  // Fetch sites from backend
  loadSites() {
    this.isLoadingTable = true; // start loader
    // this.http.get<any>('http://localhost:7668/api/sitemaster').subscribe({
      const headers = new HttpHeaders({ Authorization: `Bearer ${localStorage.getItem('token') || ''}` });
      this.http.get<any>(environment.apiUrl + 'api/sitemaster', { headers }).subscribe({
      next: (res) => {
        this.sites = res.sites.map((site: Site) => ({
          ...site,
          is_active: !!site.is_active
        }));
        this.isLoadingTable = false; // stop loader
      },
      error: (err) => {
        console.error('Error fetching sites:', err);
        alert('Failed to fetch Site Master data');
      }
    });
  }

  // ✅ Search filter logic
  // filteredSites(): Site[] {
  //   const text = this.searchText.trim().toLowerCase();
  //   if (!text) return this.sites;

  //   return this.sites.filter(site =>
  //     site.atm_latest?.toLowerCase().includes(text) ||
  //     site.atm_1?.toLowerCase().includes(text) ||
  //     site.atm_2?.toLowerCase().includes(text) ||
  //     site.atm_3?.toLowerCase().includes(text) ||
  //     site.atm_4?.toLowerCase().includes(text) ||
  //     site.atm_5?.toLowerCase().includes(text) ||
  //     site.lho_name?.toLowerCase().includes(text) ||
  //     site.vendor_name?.toLowerCase().includes(text) ||
  //     site.city?.toLowerCase().includes(text) ||
  //     site.state?.toLowerCase().includes(text) ||
  //     site.site_address?.toLowerCase().includes(text) ||
  //     String(site.pincode || '').includes(text)
  //   );
  // }

  toggleAddress(site: any) {
    site.showFullAddress = !site.showFullAddress;
  }
  toggleRow(site: any) {
    site.expanded = !site.expanded;
  }

  // ✅ Export to Excel functionality
  exportToExcel() {
    const dataToExport = this.filteredSites().map(site => ({
      'ATM Latest': site.atm_latest,
      'ATM 1': site.atm_1 || '',
      'ATM 2': site.atm_2 || '',
      'ATM 3': site.atm_3 || '',
      'ATM 4': site.atm_4 || '',
      'ATM 5': site.atm_5 || '',
      'LHO': site.lho_name || site.lho_id,
      'Vendor': site.vendor_name || site.vendor,
      'Address': site.site_address,
      'City': site.city,
      'State': site.state,
      'Pincode': site.pincode,
      'Status': site.is_active ? 'Active' : 'Inactive'
    }));

    const worksheet: XLSX.WorkSheet = XLSX.utils.json_to_sheet(dataToExport);
    const workbook: XLSX.WorkBook = { Sheets: { 'Site Master': worksheet }, SheetNames: ['Site Master'] };
    const excelBuffer = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' });

    const blob = new Blob([excelBuffer], { type: 'application/octet-stream' });
    saveAs(blob, `SiteMaster_${new Date().toISOString().split('T')[0]}.xlsx`);
  }

  loadingCell: { [key: string]: boolean } = {};

  isLoadingCell(index: number, column: string): boolean {
    return this.loadingCell[`${index}-${column}`] || false;
  }

  expandColumn(site: any, column: string, index: number) {
    const key = `${index}-${column}`;
    this.loadingCell[key] = true;

    // Simulate delay (e.g., fetching data or expanding)
    setTimeout(() => {
      site.expanded = !site.expanded;
      this.loadingCell[key] = false;
    }, 600); // adjust for realism
  }


  // ✅ Placeholder: Download sample Excel template
  // downloadSampleExcel() {
  //   const sampleData = [
  //     {
  //       'ATM ID': 'ATM12345',
  //       'LHO': 'LHO Delhi',
  //       'Vendor': 'Tata Communications',
  //       'Address': '123 Street Name, Delhi',
  //       'City': 'New Delhi',
  //       'State': 'Delhi',
  //       'Pincode': 110001,
  //       'Status': 'Active'
  //     }
  //   ];

  //   const worksheet: XLSX.WorkSheet = XLSX.utils.json_to_sheet(sampleData);
  //   const workbook: XLSX.WorkBook = { Sheets: { 'Sample Site Master': worksheet }, SheetNames: ['Sample Site Master'] };
  //   const excelBuffer: any = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' });

  //   const blob = new Blob([excelBuffer], { type: 'application/octet-stream' });
  //   saveAs(blob, `Sample_SiteMaster.xlsx`);
  // }

  // Upload placeholders

  downloadSampleExcel() {
    const sampleData = [
      {
        atm_latest: 'T1NH000123456',
        atm_1: '',
        atm_2: '',
        atm_3: '',
        atm_4: '',
        atm_5: '',
        lho_name: 'SBI-TOM-AMRA',
        vendor_name: 'Aniket Amenities',
        site_address: 'Near Main Road, Sample Area',
        city: 'Mumbai',
        state: 'Maharashtra',
        pincode: 400001,
        status: 'Active'
      }
    ];

    const worksheet = XLSX.utils.json_to_sheet(sampleData);
    const workbook: XLSX.WorkBook = {
      Sheets: { 'Sample': worksheet },
      SheetNames: ['Sample']
    };

    const buffer = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' });
    const blob = new Blob([buffer], { type: 'application/octet-stream' });
    saveAs(blob, 'Bulk_Upload_Site_Sample.xlsx');
  }

  onExcelSelected(event: any) {
    const file = event.target.files[0];
    if (file) {
      console.log('File selected:', file);
      alert(`Selected file: ${file.name}`);
    }
  }

  triggerExcelUpload() {
    const fileInput = document.getElementById('excelFile') as HTMLInputElement;
    fileInput.click();
  }

  downloadSkippedExcel(skippedRows: any[]) {
    if (!skippedRows.length) return;

    const data = skippedRows.map(r => ({
      'Excel Row': r.row,
      'Reason': r.reason
    }));

    const worksheet = XLSX.utils.json_to_sheet(data);
    const workbook: XLSX.WorkBook = {
      Sheets: { 'Skipped Rows': worksheet },
      SheetNames: ['Skipped Rows']
    };

    const buffer = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' });
    const blob = new Blob([buffer], { type: 'application/octet-stream' });

    saveAs(blob, `Skipped_Rows_${new Date().toISOString().split('T')[0]}.xlsx`);
  }


  @ViewChild('bulkFile') bulkFile!: ElementRef<HTMLInputElement>;
  @ViewChild('bulkDeleteFile') bulkDeleteFile!: ElementRef<HTMLInputElement>;


  triggerBulkUpload() {
    this.bulkFile.nativeElement.click();
  }

  downloadBulkDeleteTemplate() {
    const worksheet = XLSX.utils.aoa_to_sheet([
      ['ATM ID'],
      ['T1NH000123456']
    ]);
    worksheet['!cols'] = [{ wch: 24 }];
    const workbook: XLSX.WorkBook = {
      Sheets: { 'ATM IDs to Delete': worksheet },
      SheetNames: ['ATM IDs to Delete']
    };
    const buffer = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' });
    saveAs(
      new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
      'Bulk_Delete_Site_Template.xlsx'
    );
  }

  triggerBulkDelete() {
    this.bulkDeleteFile.nativeElement.click();
  }

  async onBulkDeleteFileSelected(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;

    try {
      const workbook = XLSX.read(await file.arrayBuffer(), { type: 'array' });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      const rows: any[] = XLSX.utils.sheet_to_json(sheet, { defval: '' });
      const atmIds = rows
        .map(row => {
          const key = Object.keys(row).find(k =>
            ['atmid', 'atmlatest'].includes(k.trim().toLowerCase().replace(/[\s_-]+/g, ''))
          );
          return key ? String(row[key]).trim() : '';
        })
        .filter(id => id && id !== '-');
      const uniqueCount = new Set(atmIds.map(id => id.toUpperCase())).size;

      if (!uniqueCount) {
        await Swal.fire('Invalid Excel', 'No ATM IDs found. Use the column heading "ATM ID".', 'error');
        return;
      }

      const confirmation = await Swal.fire({
        title: 'Confirm bulk delete',
        html: `<p><b>${uniqueCount}</b> unique ATM ID(s) were found.</p>
               <p>Matching Site Master records will be deactivated and soft-deleted.</p>`,
        icon: 'warning',
        showCancelButton: true,
        confirmButtonText: `Delete ${uniqueCount} record(s)`,
        confirmButtonColor: '#dc3545',
        cancelButtonText: 'Cancel'
      });
      if (!confirmation.isConfirmed) return;

      const formData = new FormData();
      formData.append('file', file);
      Swal.fire({
        title: 'Deleting records...',
        text: 'Please do not close this page.',
        allowOutsideClick: false,
        didOpen: () => Swal.showLoading()
      });

      this.http.post<any>(environment.apiUrl + 'api/bulk-delete-sites', formData).subscribe({
        next: (res) => {
          const skippedHtml = (res.skippedRows || []).slice(0, 20)
            .map((r: any) => `<li>Row ${r.row}${r.atmId ? ` (${r.atmId})` : ''}: ${r.reason}</li>`)
            .join('');
          Swal.fire({
            title: 'Bulk Delete Completed',
            html: `<p><b>Deleted:</b> ${res.deletedCount}</p>
                   <p><b>Skipped:</b> ${res.skippedCount}</p>
                   ${skippedHtml ? `<div class="bulk-result"><ul>${skippedHtml}</ul></div>` : ''}`,
            icon: res.deletedCount ? 'success' : 'info'
          });
          this.loadSites();
        },
        error: (err) => Swal.fire('Bulk Delete Failed', err.error?.message || 'Unable to delete records', 'error')
      });
    } catch (error) {
      await Swal.fire('Invalid Excel', 'The selected file could not be read.', 'error');
    } finally {
      input.value = '';
    }
  }

  onBulkFileSelected(event: any) {
    const file = event.target.files[0];
    if (!file) return;

    const formData = new FormData();
    formData.append('file', file);

    Swal.fire({
      title: 'Uploading...',
      text: 'Please wait while data is uploaded',
      allowOutsideClick: false,
      didOpen: () => Swal.showLoading()
    });

    // this.http.post<any>('http://localhost:7668/api/bulk-upload-sites', formData)
      this.http.post<any>(environment.apiUrl + 'api/bulk-upload-sites', formData)
      .subscribe({
        next: (res) => {
          Swal.close();

          const skippedHtml = res.skippedRows?.length
            ? `
            <div style="max-height:200px; overflow:auto; text-align:left">
              <ul>
                ${res.skippedRows
              .map((r: any) => `<li><b>Row ${r.row}:</b> ${r.reason}</li>`)
              .join('')}
              </ul>
            </div>
          `
            : '<p>No skipped rows 🎉</p>';

          Swal.fire({
            title: 'Bulk Upload Completed',
            html: `
            <p><b>Inserted:</b> ${res.insertedCount}</p>
            <p><b>Skipped:</b> ${res.skippedCount}</p>
            ${skippedHtml}
          `,
            icon: 'success',
            showCancelButton: res.skippedRows?.length > 0,
            confirmButtonText: 'OK',
            cancelButtonText: 'Download Skipped Excel'
          }).then(result => {
            if (result.dismiss === Swal.DismissReason.cancel) {
              this.downloadSkippedExcel(res.skippedRows);
            }
          });

          this.loadSites(); // reload table
        },

        error: (err) => {
          Swal.close();
          Swal.fire(
            'Error',
            err.error?.message || 'Bulk upload failed',
            'error'
          );
        }
      });
  }

  editSite(site: any) {
  this.router.navigate(['/editsite', site.id]);
}

  confirmDelete(site: any) {
    Swal.fire({
      title: 'Are you sure?',
      text: `This will delete ATM ${site.atm_latest}`,
      icon: 'warning',
      showCancelButton: true,
      confirmButtonText: 'Yes, delete',
      cancelButtonText: 'Cancel'
    }).then(result => {
      if (result.isConfirmed) {
        this.deleteSite(site);
      }
    });
  }
  deleteSite(site: any) {
    const payload = {
      id: site.id, // 🔴 IMPORTANT: ensure id is coming from API
      deleted_by: Number(localStorage.getItem('userId'))
    };

    // this.http.post('http://localhost:7668/api/delete-site', payload)
      this.http.post(environment.apiUrl + 'api/delete-site', payload)

      .subscribe({
        next: (res: any) => {
          Swal.fire('Deleted!', res.message, 'success');
          this.loadSites(); // refresh table
        },
        error: (err) => {
          Swal.fire(
            'Error',
            err.error?.message || 'Failed to delete site',
            'error'
          );
        }
      });
  }

  onSearchChange() {
    this.currentPage = 1;
  }

  currentPage: number = 1;
  pageSize: number = 10;

  get totalPages(): number {
    return Math.ceil(this.filteredSites().length / this.pageSize);
  }

  paginatedSites(): Site[] {
    const startIndex = (this.currentPage - 1) * this.pageSize;
    return this.filteredSites().slice(startIndex, startIndex + this.pageSize);
  }

  goToPage(page: number) {
    if (page < 1 || page > this.totalPages) return;
    this.currentPage = page;
  }

  nextPage() {
    if (this.currentPage < this.totalPages) {
      this.currentPage++;
    }
  }

  prevPage() {
    if (this.currentPage > 1) {
      this.currentPage--;
    }
  }


  filteredSites(): Site[] {
    const text = this.searchText.trim().toLowerCase();
    if (!text) return this.sites;

    return this.sites.filter(site =>
      site.atm_latest?.toLowerCase().includes(text) ||
      site.atm_1?.toLowerCase().includes(text) ||
      site.atm_2?.toLowerCase().includes(text) ||
      site.atm_3?.toLowerCase().includes(text) ||
      site.atm_4?.toLowerCase().includes(text) ||
      site.atm_5?.toLowerCase().includes(text) ||
      site.lho_name?.toLowerCase().includes(text) ||
      site.vendor_name?.toLowerCase().includes(text) ||
      site.city?.toLowerCase().includes(text) ||
      site.state?.toLowerCase().includes(text) ||
      site.site_address?.toLowerCase().includes(text) ||
      String(site.pincode || '').includes(text)
    );
  }


}
