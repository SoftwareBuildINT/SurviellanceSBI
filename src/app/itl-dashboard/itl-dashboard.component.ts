import { Component, OnInit } from '@angular/core';
import { Router } from '@angular/router';
import { HttpClient } from '@angular/common/http';
import { environment } from 'src/environments/environment';

@Component({
  selector: 'app-itl-dashboard',
  templateUrl: './itl-dashboard.component.html',
  styleUrls: ['./itl-dashboard.component.scss']
})
export class ITLDashboardComponent implements OnInit {
  showModal = false;
  lhoName = '';
  searchTerm: string = '';
  lhoList: any[] = [];
  filteredLhoList: any[] = [];
  atmList: string[] = [];
  filteredAtmList: string[] = [];
  userRole: string | null = null;

  totalLocations: number = 0;
  totalOnline: number = 0;
  totalOffline: number = 0;
  totalPercentage: number = 0;
  loading: boolean = true;
  loadingTotals: boolean = true;

  constructor(private router: Router, private http: HttpClient) {}

  ngOnInit() {
    this.fetchAtmList();
    this.fetchDashboardData();
    this.fetchLhoList();
    this.getUserRole();
  }

  getUserRole(): void {
    this.userRole = localStorage.getItem('roleId');
    if (!this.userRole) {
      console.error('Role ID is not set or not recognized:', this.userRole);
    }
  }

  // Fetch the ATM list for autocomplete suggestions
  fetchAtmList(): void {
    this.http.get<{ atm_list: string[] }>(`${environment.apiUrl}atm-list`).subscribe({
      next: (response) => {
        this.atmList = response.atm_list;
      },
      error: (error) => {
        console.error('Error fetching ATM list:', error);
      }
    });
  }

  filterAtmList(): void {
    if (this.searchTerm) {
      this.filteredAtmList = this.atmList.filter(atm =>
        atm.toLowerCase().includes(this.searchTerm.toLowerCase())
      );
      if (this.filteredAtmList.length === 0) {
        this.filteredAtmList = ["No Record Found"];
      }
    } else {
      this.filteredAtmList = [];
    }
  }

  selectAtm(atmId: string) {
    this.searchTerm = atmId;
    this.router.navigate(['/liveview'], { queryParams: { atmId: atmId } });
  }

  navigateToSiteDetails(lho: { LHO_Name: string; lho_id: number }) {
    if (lho.lho_id !== null) {
      this.router.navigate(['/sidedetails'], { queryParams: { lho_id: lho.lho_id } });
    }
  }

  openModal() {
    this.showModal = true;
  }

  closeModal() {
    this.showModal = false;
  }

  clearInput() {
    this.lhoName = '';
  }

  saveLho() {
    if (this.lhoName.trim()) {
      this.http.post(`${environment.apiUrl}add-lho`, { lho_name: this.lhoName }).subscribe({
        next: (response: any) => {
          alert(response.message || 'LHO saved successfully.');
          this.closeModal();
          this.fetchLhoList();
        },
        error: (error) => {
          if (error.status === 409) {
            alert('LHO Name already exists in the database.');
          } else {
            alert('An error occurred while saving the LHO.');
          }
        }
      });
    } else {
      alert('Please enter a valid LHO Name');
    }
  }

  fetchDashboardData() {
    this.loading = true;
    this.http.get<any[]>(`${environment.apiUrl}dashboardData`).subscribe({
      next: (response) => {
        this.totalLocations = response[0];

        this.lhoList = response.map(lho => ({
          LHO_Name: lho.lho_name,
          lho_id: lho.lho_id,
          total_locations: lho.total_locations,
        }));

        this.lhoList.sort((a, b) => a.LHO_Name.localeCompare(b.LHO_Name));
        this.filteredLhoList = [...this.lhoList];
        this.loading = false;
      },
      error: () => {
        alert('An error occurred while fetching the LHO list.');
        this.loading = false;
      }
    });
  }

  fetchLhoList() {
    this.loadingTotals = true;
    this.http.get<{
      totalLocations: number;
      totalOnline: number;
      totalOffline: number;
      totalPercentage: number;
      lhoDetails: any[];
    }>(`${environment.apiUrl}lho-list`).subscribe({
      next: (response) => {
        this.totalLocations = response.totalLocations;
        this.totalOnline = response.totalOnline;
        this.totalOffline = response.totalOffline;

        // ✅ Fixed percentage calculation
        this.totalPercentage = this.totalLocations 
          ? parseFloat(((this.totalOnline / this.totalLocations) * 100).toFixed(2)) 
          : 0;

        // Filter only ITL data
        this.lhoList = response.lhoDetails
          .filter(lho => lho.LHO_Name.toLowerCase().includes('itl'))
          .map(lho => ({
            LHO_Name: lho.lho_name,
            lho_id: lho.lho_id,
            total_locations: lho.total_locations,
            onlineCount: lho.onlineCount,
            offlineCount: lho.offlineCount,
            percentage: lho.percentage
          }));

        this.lhoList.sort((a, b) => a.LHO_Name.localeCompare(b.LHO_Name));
        this.filteredLhoList = [...this.lhoList];
        this.loadingTotals = false;
      },
      error: () => {
        alert('An error occurred while fetching the ITL LHO list.');
        this.loadingTotals = false;
      }
    });
  }
}
