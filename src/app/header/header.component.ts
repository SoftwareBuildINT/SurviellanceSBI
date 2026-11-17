import {
  Component,
  OnInit,
  Input,
  ElementRef,
  HostListener
} from '@angular/core';
import { Router } from '@angular/router';
import { DataService } from '../data.service';
import { IdleService } from '../services/idle.service';

@Component({
  selector: 'app-header',
  templateUrl: './header.component.html',
  styleUrls: ['./header.component.scss']
})
export class HeaderComponent implements OnInit {

  @Input() heading: string = '';

  userEmail: string = '';
  isSidebarOpen = false;
  isDropdownOpen = false;

  passwordExpiryDays: number = 0;
  passwordStatus: '' | 'valid' | 'expired' = '';

  constructor(
    private dataService: DataService,
    private eRef: ElementRef,
    private router: Router,
    private idleService: IdleService
  ) {}

  ngOnInit(): void {
    // ✔ Load email
    this.userEmail = localStorage.getItem('userEmail') || 'No email found';

    // ✔ Fetch password expiry
    const userId = localStorage.getItem('userId');
    if (userId) {
      this.checkPasswordExpiry(userId);
    } else {
      console.warn('User ID not found in localStorage');
      this.passwordStatus = 'expired';
    }
  }

  checkPasswordExpiry(userId: string): void {
    this.passwordStatus = ''; // loading state

    this.dataService.getPasswordExpiry(userId).subscribe({
      next: (res) => {
        console.log('Password expiry response:', res);

        this.passwordStatus = res.status; // valid | expired
        this.passwordExpiryDays = res.daysLeft ?? 0;

        // 🔐 Optional hard enforcement
        // if (res.status === 'expired') {
        //   this.router.navigate(['/changepassword']);
        // }
      },
      error: (err) => {
        console.error('Password expiry API failed:', err);
        this.passwordStatus = 'expired';
        this.passwordExpiryDays = 0;
      }
    });
  }

  toggleSidebar(): void {
    this.isSidebarOpen = !this.isSidebarOpen;
  }

  toggleDropdown(): void {
    this.isDropdownOpen = !this.isDropdownOpen;
  }

  selectItem(item: string): void {
    this.isDropdownOpen = false;

    if (item === 'Logout') {
      this.dataService.logout().subscribe({
        next: () => this.clearSessionAndRedirect(),
        error: () => this.clearSessionAndRedirect()
      });
    }
  }

  private clearSessionAndRedirect(): void {
    this.idleService.stopWatching();
    localStorage.clear();
    sessionStorage.clear();
    this.router.navigate(['/login']);
  }

  // ✔ Close dropdown on outside click
  @HostListener('document:click', ['$event'])
  handleClickOutside(event: Event): void {
    if (!this.eRef.nativeElement.contains(event.target)) {
      this.isDropdownOpen = false;
    }
  }
}
