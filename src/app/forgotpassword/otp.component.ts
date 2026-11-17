import { Component, OnInit, OnDestroy } from '@angular/core';
import { FormBuilder, FormGroup, FormArray } from '@angular/forms';
import { Router } from '@angular/router';
import { HttpClient } from '@angular/common/http';
import { environment } from 'src/environments/environment';

@Component({
  selector: 'app-otp',
  templateUrl: './otp.component.html',
  styleUrls: ['./otp.component.scss']
})
export class OtpComponent1 implements OnInit, OnDestroy {
  otpForm!: FormGroup;
  timer: number = 120;
  interval: any;

  errorMessage: string = '';
  successMessage: string = '';
  showPopup: boolean = false;

  apiVerifyOtp = `${environment.apiUrl}forgot/verify-otp`;

  constructor(
    private fb: FormBuilder,
    private http: HttpClient,
    private router: Router
  ) {}

  ngOnInit(): void {
    this.otpForm = this.fb.group({
      otp: this.fb.array(new Array(6).fill('').map(() => this.fb.control('')))
    });
    this.startTimer();
  }

  ngOnDestroy(): void {
    clearInterval(this.interval);
  }

  // ✅ single safe getter
  get otpControls(): FormArray {
    if (!this.otpForm) {
      return this.fb.array([]);
    }
    return this.otpForm.get('otp') as FormArray;
  }

  startTimer(): void {
    this.timer = 300;
    clearInterval(this.interval);
    this.interval = setInterval(() => {
      if (this.timer > 0) {
        this.timer--;
      } else {
        clearInterval(this.interval);
      }
    }, 1000);
  }

  onInput(event: any, index: number): void {
    const input = event.target.value;
    if (/[^0-9]/.test(input)) {
      event.target.value = '';
      return;
    }
    if (input && index < this.otpControls.length - 1) {
      const next = document.querySelectorAll<HTMLInputElement>('input')[index + 1];
      next.focus();
    }
  }

  onKeydown(event: KeyboardEvent, index: number): void {
    if (!/[0-9]/.test(event.key) && event.key !== 'Backspace') {
      event.preventDefault();
    }
    if (event.key === 'Backspace' && index > 0 && !this.otpControls.at(index).value) {
      const prev = document.querySelectorAll<HTMLInputElement>('input')[index - 1];
      prev.focus();
    }
  }

  verifyOtp(): void {
  const otpString = this.otpControls.value.join('');
  const otp = Number(otpString);

  if (Number.isNaN(otp)) {
    this.errorMessage = 'Enter a valid numeric OTP';
    return;
  }

  const userEmail = localStorage.getItem('userEmail');
  if (!userEmail) {
    this.errorMessage = 'No email found in session';
    return;
  }

  if (!otpString || otpString.length !== 6) {
    this.errorMessage = 'Enter a valid 6-digit OTP';
    return;
  }

  this.http.post<any>(this.apiVerifyOtp, { userEmail, otp }).subscribe({
    next: (res) => {
      console.log('OTP verify response:', res);
      if (res.verified) {
        clearInterval(this.interval);
        this.successMessage = 'OTP verified. Redirecting to password reset...';

        // Store the signed reset token so /forgot/reset-password can verify it (#4)
        if (res.resetToken) {
          localStorage.setItem('resetToken', res.resetToken);
        }

        setTimeout(() => {
          this.router.navigate(['/changepassword1']);
        }, 1500);

      } else if (res.attemptsExceeded) {
        this.errorMessage = 'Too many failed OTP attempts. Redirecting to login...';

        // ✅ Popup only here
        this.showPopup = true;

        setTimeout(() => {
          this.router.navigate(['/login']);
        }, 2500);

      } else {
        // ❌ Just show inline error, no popup
        this.errorMessage = res.message || `Invalid OTP. You have ${res.attemptsLeft} attempts left.`;
      }
    },
    error: () => {
      this.errorMessage = 'Server error. Please try again later.';
    }
  });
}


  closePopup(): void {
    this.showPopup = false;
  }

  get formattedTimer(): string {
    const minutes = Math.floor(this.timer / 60);
    const seconds = this.timer % 60;
    return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
  }
}
