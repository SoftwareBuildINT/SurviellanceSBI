import { Component, OnInit } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { HttpClient } from '@angular/common/http';
import Swal from 'sweetalert2';
import { environment } from 'src/environments/environment.prod';

interface ApiResponse {
  success?: boolean;
  message?: string;
  data?: any;
}

@Component({
  selector: 'app-edit-site',
  templateUrl: './editsite.component.html',
  styleUrls: ['./editsite.component.scss']
})
export class EditSiteComponent implements OnInit {

  siteId!: number;

  site: any = {
    atm_latest: '',
    atm_1: '',
    atm_2: '',
    atm_3: '',
    atm_4: '',
    atm_5: '',
    lho_id: '',
    vendor: '',
    site_address: '',
    city: '',
    state: '',
    pincode: '',
    is_active: 1
  };

  lhoList: any[] = [];
  vendorList: any[] = [];

  constructor(
    private route: ActivatedRoute,
    private http: HttpClient,
    private router: Router
  ) {}

  ngOnInit(): void {
    this.siteId = Number(this.route.snapshot.paramMap.get('id'));
    this.fetchDropdowns();
    this.loadSiteDetails();
  }

  fetchDropdowns() {
    // this.http.get<any[]>('http://localhost:7668/lho-list1')
    this.http.get<any[]>(environment.apiUrl + 'lho-list1')
      .subscribe(res => this.lhoList = res);

    // this.http.get<any[]>('http://localhost:7668/vendors')
    this.http.get<any[]>(environment.apiUrl + 'vendors')
      .subscribe(res => this.vendorList = res);
  }

  loadSiteDetails() {
    // this.http.get<any>(`http://localhost:7668/api/site/${this.siteId}`)
    this.http.get<any>(`${environment.apiUrl}api/site/${this.siteId}`) 
      .subscribe({
        next: res => {
          this.site = res;
        },
        error: () => {
          Swal.fire('Error', 'Failed to load site details', 'error');
        }
      });
  }

  updateSite() {
    const payload = {
      ...this.site,
      updated_by: Number(localStorage.getItem('userId'))
    };

    // this.http.post<ApiResponse>('http://localhost:7668/api/update-site', payload)
    this.http.post<ApiResponse>(environment.apiUrl + 'api/update-site', payload)
      .subscribe({
        next: res => {
          Swal.fire(
            'Success',
            res.message || 'Site updated successfully',
            'success'
          );
          this.router.navigate(['/sitemaster']);
        },
        error: err => {
          Swal.fire(
            'Error',
            err.error?.message || 'Update failed',
            'error'
          );
        }
      });
  }

  cancel() {
    this.router.navigate(['/sitemaster']);
  }

  validatePincode(event: KeyboardEvent) {
    if (!/^\d$/.test(event.key)) {
      event.preventDefault();
    }
  }
}
