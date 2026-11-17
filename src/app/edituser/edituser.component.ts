import { Component, OnInit, HostListener, ElementRef } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { HttpClient } from '@angular/common/http';
import { environment } from 'src/environments/environment';

interface LHO {
  lho_id: number;
  lho_name: string;
}

@Component({
  selector: 'app-edit-user',
  templateUrl: './edituser.component.html',
  styleUrls: ['./edituser.component.scss']
})
export class EditUserComponent implements OnInit {
  userId!: number;
  user: any = {
    first_name: '',
    last_name: '',
    email_id: '',
    contact: '',
    role_id: null,
    is_active: null
  };

  roles: any[] = [];
  loading = true;
  showPopup: boolean = false;
  isAdminRole = false;

  lhoList: LHO[] = [];
  selectedLhoIds: number[] = [];
  lhoDropdownOpen = false;

  private rawLhoId: string | null = null;
  private userDataLoaded = false;
  private lhoListLoaded = false;

  constructor(
    private route: ActivatedRoute,
    private http: HttpClient,
    private router: Router,
    private eRef: ElementRef
  ) { }

  ngOnInit(): void {
    this.userId = +this.route.snapshot.paramMap.get('id')!;
    this.loadRoles();
    this.fetchLHOList();
  }

  // Load all roles
  loadRoles() {
    this.http.get(`${environment.apiUrl}roles`).subscribe({
      next: (res: any) => {
        this.roles = res;
        this.loadUserData();
      },
      error: (err) => {
        console.error('Error fetching roles:', err);
        alert('Failed to load roles');
        this.loading = false;
      }
    });
  }

  // Load user data and convert role_id to number for proper pre-selection
  loadUserData() {
    this.http.get(`${environment.apiUrl}users/${this.userId}`).subscribe({
      next: (res: any) => {
        this.user = {
          ...res,
          role_id: +res.role_id,
          is_active: +res.is_active
        };
        this.rawLhoId = res.lho_id;
        this.userDataLoaded = true;
        const loadedRole = this.roles.find(r => r.role_id === this.user.role_id);
        this.isAdminRole = !!loadedRole && loadedRole.role_name.toLowerCase() === 'admin';
        this.initializeLhoSelection();
        this.loading = false;
      },
      error: (err) => {
        console.error('Error loading user:', err);
        alert('Failed to load user data');
        this.loading = false;
      }
    });
  }

  fetchLHOList(): void {
    const url = `${environment.apiUrl}api/getLHOList`;
    this.http.get<LHO[]>(url).subscribe({
      next: (res) => {
        this.lhoList = res;
        this.lhoListLoaded = true;
        this.initializeLhoSelection();
      },
      error: (err) => console.error('Error fetching LHO list:', err)
    });
  }

  private initializeLhoSelection(): void {
    if (!this.userDataLoaded || !this.lhoListLoaded) return;
    if (!this.rawLhoId) {
      this.selectedLhoIds = this.lhoList.map(l => l.lho_id);
    } else {
      this.selectedLhoIds = this.rawLhoId.toString().split(',').map(Number).filter(n => !isNaN(n));
    }
  }

  // Multi-select LHO helpers
  get isAllSelected(): boolean {
    return this.lhoList.length > 0 && this.selectedLhoIds.length === this.lhoList.length;
  }

  get isIndeterminate(): boolean {
    return this.selectedLhoIds.length > 0 && this.selectedLhoIds.length < this.lhoList.length;
  }

  get lhoDisplayLabel(): string {
    if (this.selectedLhoIds.length === 0) return 'Select LHO';
    if (this.isAllSelected) return 'All LHOs Selected';
    if (this.selectedLhoIds.length === 1) {
      const lho = this.lhoList.find(l => l.lho_id === this.selectedLhoIds[0]);
      return lho ? lho.lho_name : 'Select LHO';
    }
    return `${this.selectedLhoIds.length} LHOs Selected`;
  }

  toggleAllLhos(): void {
    if (this.isAllSelected) {
      this.selectedLhoIds = [];
    } else {
      this.selectedLhoIds = this.lhoList.map(l => l.lho_id);
    }
  }

  toggleLho(lhoId: number): void {
    const idx = this.selectedLhoIds.indexOf(lhoId);
    if (idx > -1) {
      this.selectedLhoIds.splice(idx, 1);
    } else {
      this.selectedLhoIds.push(lhoId);
    }
  }

  isLhoSelected(lhoId: number): boolean {
    return this.selectedLhoIds.includes(lhoId);
  }

  toggleLhoDropdown(): void {
    this.lhoDropdownOpen = !this.lhoDropdownOpen;
  }

  @HostListener('document:click', ['$event'])
  onDocumentClick(event: Event): void {
    if (!this.eRef.nativeElement.contains(event.target)) {
      this.lhoDropdownOpen = false;
    }
  }

  getRoleName(roleId: number): string {
    const role = this.roles.find(r => r.role_id === roleId);
    return role ? role.role_name : '';
  }

  onRoleChange(): void {
    const selectedRole = this.roles.find(r => Number(r.role_id) === Number(this.user.role_id));
    this.isAdminRole = !!selectedRole && String(selectedRole.role_name).toLowerCase() === 'admin';
    if (this.isAdminRole) {
      this.selectedLhoIds = this.lhoList.map(l => l.lho_id);
      this.lhoDropdownOpen = false;
    }
  }

  // Submit edited user
  onSubmit(form: any) {
    if (form.invalid) return;

    if (this.selectedLhoIds.length === 0) {
      alert('Please select at least one LHO.');
      return;
    }

    const lhoIdValue: string | null = this.isAllSelected
      ? null
      : this.selectedLhoIds.join(',');

    const { first_name, last_name, email_id, contact, role_id, is_active } = this.user;
    const payload = {
      first_name,
      last_name,
      email_id,
      contact,
      role_id: Number(role_id),
      is_active: Number(is_active),
      lho_id: lhoIdValue
    };

    this.http.put(`${environment.apiUrl}users/${this.userId}`, payload).subscribe({
      next: () => {
        this.showPopup = true;
        setTimeout(() => {
          this.showPopup = false;
          this.router.navigate(['/usermanagement']);
        }, 2000);
      },
      error: (err) => {
        console.error('Update failed:', err);
        alert(err.error?.error || 'Update failed');
      }
    });
  }

  onCancel() {
    this.router.navigate(['/usermanagement']);
  }

}
