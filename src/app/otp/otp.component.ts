import { Component, OnInit, OnDestroy } from '@angular/core';
import { FormBuilder, FormGroup, FormArray } from '@angular/forms';
import { Router } from '@angular/router';
import { AuthService } from '../services/auth.service';
import { NotificationService } from '../services/notification.service';
import { NetworkService } from '../services/network.service';
import { IdleService } from '../services/idle.service';

@Component({
  selector: 'app-otp',
  templateUrl: './otp.component.html',
  styleUrls: ['./otp.component.scss']
})
export class OtpComponent implements OnInit, OnDestroy {
  otpForm!: FormGroup;
  timer: number = 300;  // 2-minute timer in seconds
  interval: any;
  attempts: number = 0;
  maxAttempts: number = 3;

  errorMessage: string = '';
  showPopup: boolean = false;
  userEmail: string | null = null;

  constructor(
    private fb: FormBuilder,
    private authService: AuthService,
    private router: Router,
    private notificationService: NotificationService,
    private networkService: NetworkService,
    private idleService: IdleService
  ) { }

  ngOnInit(): void {
    this.otpForm = this.fb.group({
      otp: this.fb.array(new Array(6).fill('').map(() => this.fb.control('')))
    });

    // Guard: a valid tempToken MUST exist — it proves the user passed the password check.
    // Without it the /verify-otp backend call will be rejected with 401 anyway,
    // but we redirect immediately to give instant feedback and prevent probing.
    const tempToken = localStorage.getItem('tempToken');
    if (!tempToken) {
      this.router.navigate(['/login']);
      return;
    }

    // Try to get email from navigation state first, then fallback to localStorage
    const stateEmail = (history && (history.state as any)?.email) ? (history.state as any).email : null;
    this.userEmail = stateEmail || localStorage.getItem('userEmail');

    if (!this.userEmail) {
      this.errorMessage = 'No email found in session. Redirecting to login...';
      setTimeout(() => this.router.navigate(['/login']), 1500);
      return;
    }

    this.startTimer();
  }

  ngOnDestroy(): void {
    clearInterval(this.interval); // Clean up the interval when the component is destroyed
  }

  get otpControls(): FormArray {
    return this.otpForm.get('otp') as FormArray;
  }

  startTimer(): void {
    this.interval = setInterval(() => {
      if (this.timer > 0) {
        this.timer--;
      } else {
        clearInterval(this.interval);
      }
    }, 1000); // Update every second
  }

  // Restrict input to only digits and auto-focus to the next input
  onInput(event: any, index: number): void {
    const input = event.target.value;
    // Allow only digits
    if (/[^0-9]/.test(input)) {
      event.target.value = ''; // Clear invalid input
      this.otpControls.at(index).setValue(''); // Also clear the form control
      return;
    }

    // Move focus to next input field if there is a valid digit
    if (input && index < this.otpControls.length - 1) {
      const next = document.querySelectorAll<HTMLInputElement>('.otp-box')[index + 1];
      if (next) next.focus();
    }
  }

  // Prevent non-digit characters and handle backspace to focus on previous input
  onKeydown(event: KeyboardEvent, index: number): void {
    // Allow only numeric input
    if (!/[0-9]/.test(event.key) && event.key !== 'Backspace') {
      event.preventDefault();
    }

    // Move focus to the previous input field on backspace
    if (event.key === 'Backspace' && index > 0 && !this.otpControls.at(index).value) {
      const prev = document.querySelectorAll<HTMLInputElement>('.otp-box')[index - 1];
      if (prev) prev.focus();
    }
  }

  submitOtp(): void {
    const otp = Number(this.otpControls.value.join(''));
    const email = this.userEmail || localStorage.getItem('userEmail');

    if (!email) {
      this.errorMessage = 'No email found in session';
      setTimeout(() => this.router.navigate(['/login']), 1500);
      return;
    }

    // Clear previous error message
    this.errorMessage = '';

    this.authService.verifyOtp(email, otp.toString()).subscribe({
      next: (res: any) => {
        if (res.success) {
          // Store the final verified token and remove the one-time tempToken
          localStorage.setItem('token', res.token);
          localStorage.removeItem('tempToken');

          // Start idle watcher only after full authentication is complete
          this.idleService.startWatching();

          if (res.redirect === 'newpassword') {
            this.router.navigate(['/changepassword']);
          } else {
            this.router.navigate(['/dashboard']);
          }
        } else {
          this.handleFailedAttempt();
        }
      },
      error: (err) => {
        console.error('Error verifying OTP', err);
        
        // Handle specific network errors with user-friendly notifications
        if (!this.networkService.getCurrentStatus()) {
          this.notificationService.showConnectionError();
          this.errorMessage = 'No internet connection detected.';
        } else if (err.message && err.message.includes('timeout')) {
          this.notificationService.showTimeoutError();
          this.errorMessage = 'Request timed out. Please try again.';
        } else if (err.message && err.message.includes('Network error')) {
          this.notificationService.showError('Connection failed. Please check your network and try again.', 8000);
          this.errorMessage = 'Connection failed. Please check your network.';
        } else if (err.status === 500) {
          this.notificationService.showError('Server error. Please contact support if the problem persists.', 8000);
          this.errorMessage = 'Server error occurred. Please try again.';
        } else {
          this.handleFailedAttempt();
        }
      }
    });
  }

  private handleFailedAttempt(): void {
    this.attempts++;
    if (this.attempts >= this.maxAttempts) {
      this.showPopup = true;   // ✅ Show popup only after 3 failed attempts
    } else {
      this.errorMessage = `Invalid OTP. ${this.maxAttempts - this.attempts} attempt(s) left.`;
    }
  }

  closePopup(): void {
    this.showPopup = false;
  }

  // Getter to display the formatted timer (MM:SS)
  get formattedTimer(): string {
    const minutes = Math.floor(this.timer / 60);
    const seconds = this.timer % 60;
    return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
  }
}
