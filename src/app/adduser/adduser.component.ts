import { Component, OnInit, HostListener, ElementRef } from '@angular/core';
import { NgForm } from '@angular/forms';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { catchError } from 'rxjs/operators';
import { throwError } from 'rxjs';
import { environment } from 'src/environments/environment';

interface Role {
  id: number;
  name: string;
}

interface LHO {
  lho_id: number;
  lho_name: string;
}

@Component({
  selector: 'app-adduser',
  templateUrl: './adduser.component.html',
  styleUrls: ['./adduser.component.scss']
})
export class AdduserComponent implements OnInit {
  apiUrl = `${environment.apiUrl}register`;

  user = {
    firstName: '',
    lastName: '',
    email: '',
    phoneNumber: '',
    role: ''
  };

  roles: Role[] = [
    { id: 1, name: 'Admin' },
    { id: 2, name: 'SubAdmin' },
    { id: 3, name: 'User' }
  ];

  lhoList: LHO[] = [];
  selectedLhoIds: number[] = [];
  lhoDropdownOpen = false;

  constructor(private http: HttpClient, private eRef: ElementRef) { }

  ngOnInit(): void {
    this.fetchLHOList();
  }

  fetchLHOList(): void {
    const url = `${environment.apiUrl}api/getLHOList`;
    this.http.get<LHO[]>(url).subscribe(
      (res) => {
        this.lhoList = res;
      },
      (err) => console.error('Error fetching LHO list:', err)
    );
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

  validatePhoneNumber(event: KeyboardEvent): void {
    const allowedKeys = ['Backspace', 'ArrowLeft', 'ArrowRight', 'Tab'];
    const key = event.key;
    if (!allowedKeys.includes(key) && (key < '0' || key > '9')) {
      event.preventDefault();
    }
  }

  formatPhoneNumber(event: Event): void {
    const input = event.target as HTMLInputElement;
    let value = input.value.replace(/\D/g, '');
    if (value.length > 10) value = value.substring(0, 10);
    input.value = value;
    this.user.phoneNumber = value;
  }

  onSubmit(form: NgForm): void {
    if (!form.valid) {
      alert('Please fill in all required fields.');
      return;
    }

    const roleId = this.mapRoleToId(this.user.role);
    if (!roleId) {
      alert('Please select a valid Role.');
      return;
    }

    if (this.selectedLhoIds.length === 0) {
      alert('Please select at least one LHO.');
      return;
    }

    // If all LHOs are selected, send null; otherwise send comma-separated IDs
    const lhoIdValue: string | null = this.isAllSelected
      ? null
      : this.selectedLhoIds.join(',');

    const userData = {
      first_name: this.user.firstName,
      last_name: this.user.lastName,
      email_id: this.user.email,
      contact: this.user.phoneNumber,
      role_id: roleId,
      lho_id: lhoIdValue
    };

    const token = localStorage.getItem('token');
    const headers = new HttpHeaders({ 'Authorization': `Bearer ${token}` });

    this.http.post(this.apiUrl, userData, { headers })
      .pipe(
        catchError(error => {
          console.error('Error registering user:', error);
          alert('Registration failed: ' + (error.error.message || 'Unknown error'));
          return throwError(error);
        })
      )
      .subscribe(response => {
        console.log('User registered successfully!', response);
        alert('User registered successfully!');
        form.resetForm();
        this.user.role = '';
        this.selectedLhoIds = [];
        this.lhoDropdownOpen = false;
      });
  }

  mapRoleToId(roleName: string): number {
    const role = this.roles.find(r => r.name.toLowerCase() === roleName.toLowerCase());
    return role ? role.id : 0;
  }
}
