import { Component, OnInit } from '@angular/core';
import { NgForm } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { catchError } from 'rxjs/operators';
import { throwError } from 'rxjs';
import { environment } from 'src/environments/environment';
import Swal from 'sweetalert2';

interface LHO {
    lho_id: number;
    lho_name: string;
}

interface Vendor {
    vendor_id: number;
    vendor_name: string;
}

@Component({
    selector: 'app-addsite',
    templateUrl: './addsite.component.html',
    styleUrls: ['./addsite.component.scss']
})
export class AddsiteComponent implements OnInit {
    apiUrl = `${environment.apiUrl}add-site`;

    site = {
  atmLatest: '',
  atm1: '',
  atm2: '',
  atm3: '',
  atm4: '',
  atm5: '',
  lhoId: '',
  isActive: '1',
  vendorId: '',
  address: '',
  city: '',
  state: '',
  pincode: ''
};

    lhoList: LHO[] = [];
    vendorList: Vendor[] = [];

    constructor(private http: HttpClient) { }

    ngOnInit(): void {
        this.loadDropdownData();
    }

    /** Load both LHO and Vendor data */
    loadDropdownData(): void {
        this.fetchLHOList();
        this.fetchVendorList();
    }

    /** Fetch LHO list from API */
    fetchLHOList(): void {
        const url = `${environment.apiUrl}lho-list1`;
        this.http.get<LHO[]>(url).subscribe({
            next: (res) => {
                this.lhoList = res || [];
                console.log('LHO List:', this.lhoList);
            },
            error: (err) => console.error('Error fetching LHO list:', err)
        });
    }

    /** Fetch Vendor list from API */
    fetchVendorList(): void {
        const url = `${environment.apiUrl}vendors`;
        this.http.get<Vendor[]>(url).subscribe({
            next: (res) => {
                this.vendorList = res || [];
                console.log('Vendor List:', this.vendorList);
            },
            error: (err) => console.error('Error fetching Vendor list:', err)
        });
    }

    /** Allow only numeric pincode input */
    validatePincode(event: KeyboardEvent): void {
        const allowedKeys = ['Backspace', 'ArrowLeft', 'ArrowRight', 'Tab'];
        const key = event.key;
        if (!allowedKeys.includes(key) && (key < '0' || key > '9')) {
            event.preventDefault();
        }
    }
    downloadSampleExcel() {
        // Example: serve a sample Excel file from assets
        const link = document.createElement('a');
        link.href = 'assets/site_details_sample.xlsx'; // make sure file exists in assets folder
        link.download = 'site_details_sample.xlsx';
        link.click();
    }

    onFileUpload(event: any) {
        const file = event.target.files[0];
        if (file) {
            console.log('Selected file:', file.name);
            // TODO: send file to backend for bulk upload
            // Example: this.http.post('API_URL/upload-sites', formData)
        }
    }

    /** Submit form */
     onSubmit(form: NgForm): void {
    if (!form.valid) {
      Swal.fire('Warning!', 'Please fill all required fields.', 'warning');
      return;
    }

    /** ✅ FINAL PAYLOAD (MATCHES atm_list_new) */
    const payload = {
      atm_latest: this.site.atmLatest.trim(),
      atm_1: this.site.atm1 || null,
      atm_2: this.site.atm2 || null,
      atm_3: this.site.atm3 || null,
      atm_4: this.site.atm4 || null,
      atm_5: this.site.atm5 || null,
      lho_id: Number(this.site.lhoId),
      is_active: Number(this.site.isActive),
      vendor: Number(this.site.vendorId),
      site_address: this.site.address.trim(),
      city: this.site.city.trim(),
      state: this.site.state.trim(),
      pincode: Number(this.site.pincode)
    };

    console.log('📤 Sending payload:', payload);

    this.http.post(this.apiUrl, payload).pipe(
      catchError(error => {
        Swal.fire(
          'Error!',
          error.error?.message || 'Failed to add site',
          'error'
        );
        return throwError(() => error);
      })
    ).subscribe((res: any) => {
      Swal.fire('Success!', res.message || 'Site added successfully', 'success')
        .then(() => form.resetForm());
    });
  }

}
