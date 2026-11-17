import { Component, OnInit } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Router } from '@angular/router';
import { environment } from 'src/environments/environment';
import * as XLSX from 'xlsx';
import { saveAs } from 'file-saver';

@Component({
  selector: 'app-usermanagement',
  templateUrl: './usermanagement.component.html',
  styleUrls: ['./usermanagement.component.scss']
})
export class UsermanagementComponent implements OnInit {
  users: any[] = [];
  showDeleteModal = false;
  userIdToDelete: number | null = null;
  userRole: string | null = null; // Track user role
  currentUserId: string | null = null; // Store current user ID
  showUnlockModal: boolean = false;
  unlockUserId: number | null = null;
  roles = [
    { role_id: 1, role_name: 'Admin' },
    { role_id: 2, role_name: 'Sub-Admin' },
    { role_id: 3, role_name: 'User' }
  ];
  showUnlockSuccess: boolean = false;
  unlockMessage: string = '';

  selectedFile: File | null = null; // For Excel upload
  searchTerm: string = '';
  filteredUsers: any[] = [];
  activeTab: 'active' | 'inactive' = 'active';
  constructor(
    private http: HttpClient,
    private router: Router
  ) { }

  ngOnInit(): void {
    this.currentUserId = localStorage.getItem('userId');
    this.getUserRole();
    this.fetchUsers();
  }

  // ================== FETCH USERS ==================
  fetchUsers(): void {
    this.http.get(`${environment.apiUrl}users`).subscribe(
      (data: any) => {
        this.users = data;
        this.applyFilter();
      },
      (error) => {
        console.error('Error fetching user data', error);
      }
    );
  }

  // ================== TAB ==================
  get activeCount(): number {
    return this.users.filter(u => !u.is_delete || u.is_delete === 0).length;
  }

  get inactiveCount(): number {
    return this.users.filter(u => u.is_delete === 1).length;
  }

  setTab(tab: 'active' | 'inactive'): void {
    this.activeTab = tab;
    this.applyFilter();
  }

  applyFilter(): void {
    const term = this.searchTerm.toLowerCase();
    const base = this.users.filter(u =>
      this.activeTab === 'active'
        ? !u.is_delete || u.is_delete === 0
        : u.is_delete === 1
    );
    this.filteredUsers = term
      ? base.filter(u =>
          (u.first_name + ' ' + u.last_name).toLowerCase().includes(term) ||
          u.email_id.toLowerCase().includes(term) ||
          (u.contact ? u.contact.toString().includes(term) : false)
        )
      : base;
  }

  // ================== ROLE ==================
  getUserRole(): void {
    this.userRole = localStorage.getItem('roleId');
    if (!this.userRole) {
      console.error('Role ID is not set or not recognized:', this.userRole);
    }
  }

  // ================== DELETE ==================
  openDeleteConfirmation(userId: number) {
    this.userIdToDelete = userId;
    this.showDeleteModal = true;
  }

  closeDeleteModal() {
    this.showDeleteModal = false;
    this.userIdToDelete = null;
  }

  confirmDelete() {
    if (this.userIdToDelete !== null) {
      this.deleteUser(this.userIdToDelete);
      this.closeDeleteModal();
    }
  }

  deleteUser(userId: number) {
    if (!this.currentUserId) {
      alert('Current user ID not found. Please login again.');
      return;
    }

    const headers = new HttpHeaders({
      'userid': this.currentUserId,
      'Authorization': localStorage.getItem('token') || ''
    });

    this.http.post(`${environment.apiUrl}users/${userId}`, {}, { headers })
      .subscribe({
        next: (res) => {
          console.log('User deleted:', res);
          this.fetchUsers();
        },
        error: (err) => {
          console.error('Delete failed:', err);
          alert(err.error?.error || 'Unauthorized or failed');
        }
      });
  }

  // ================== EDIT ==================
  openEditUser(userId: number) {
    console.log('Navigating to edit user with ID:', userId);
    this.router.navigate(['/users/edit', userId]);
  }

  // ================== UNLOCK ==================
  openUnlockConfirmation(userId: number) {
    this.unlockUserId = userId;
    this.showUnlockModal = true;
  }

  closeUnlockModal() {
    this.showUnlockModal = false;
    this.unlockUserId = null;
  }

  confirmUnlock() {
    if (!this.unlockUserId) return;

    this.http.put(`${environment.apiUrl}users/unlock/${this.unlockUserId}`, {})
      .subscribe({
        next: (response: any) => {
          this.unlockMessage = response.message || 'User unlocked successfully.';
          this.showUnlockSuccess = true;
          this.closeUnlockModal();
          this.fetchUsers();
        },
        error: (error) => {
          console.error('Error unlocking user:', error);
          this.unlockMessage = 'An error occurred while unlocking the user.';
          this.showUnlockSuccess = true;
        }
      });
  }

  // ================== EXPORT EXCEL ==================
  exportToExcel() {
    const data = this.users.map(user => {
      const role = this.roles.find(r => r.role_id == user.role_id);
      return {
        "First Name": user.first_name || '',
        "Last Name": user.last_name || '',
        "Email": user.email_id || '',
        "Contact": user.contact || '',
        "Role": role ? role.role_name : '',
        "Active Status": user.is_active === 1 ? 'Active' : 'Inactive',
        "Created At": user.created_at || ''
      };
    });

    const ws: XLSX.WorkSheet = XLSX.utils.json_to_sheet(data);
    const wb: XLSX.WorkBook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Users');

    const excelBuffer: any = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
    const blob: Blob = new Blob([excelBuffer], { type: 'application/octet-stream' });
    saveAs(blob, 'users.xlsx');
  }

  // ================== UPLOAD EXCEL ==================
  triggerExcelUpload() {
    const fileInput = document.getElementById('excelFile') as HTMLInputElement;
    fileInput.click();
  }

  onExcelSelected(event: any) {
    if (event.target.files.length > 0) {
      this.selectedFile = event.target.files[0];
      this.uploadExcel();
    }
  }
  downloadSampleExcel() {
    // Sample headers
    const data = [
      {
        "First Name": "",
        "Last Name": "",
        "Email": "",
        "Contact": "",
        "Role": "Admin / Sub Admin / User",
        "Active Status": "Active / Inactive",
        "LHO": "LHO name or LHO ID"
      }
    ];

    const ws: XLSX.WorkSheet = XLSX.utils.json_to_sheet(data);
    const wb: XLSX.WorkBook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'SampleUsers');

    const excelBuffer: any = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
    const blob: Blob = new Blob([excelBuffer], { type: 'application/octet-stream' });
    saveAs(blob, 'SampleUserUpload.xlsx');
  }

  uploadExcel() {
    if (!this.selectedFile) return;

    const formData = new FormData();
    formData.append('file', this.selectedFile);

    this.http.post<any>(`${environment.apiUrl}bulk-upload-users`, formData)
      .subscribe({
        next: (res) => {
          this.fetchUsers(); // refresh users after upload

          if (res.errors.length === 0) {
            this.showPopup(`Upload completed! Inserted: ${res.inserted}, Skipped: ${res.skipped}`);
          } else {
            const errorEmails = res.errors.map((e: any) => e.email).join(', ');
            this.showPopup(`Upload completed with errors for: ${errorEmails}`);
          }
        },
        error: (err) => {
          console.error(err);
          this.showPopup('Upload failed! Please try again.');
        }
      });

  }

  // ================== TOAST ==================
  showPopup(message: string) {
    alert(message);
  }

  // ================== SEARCH ==================
  searchUsers(): void {
    this.applyFilter();
  }

}
