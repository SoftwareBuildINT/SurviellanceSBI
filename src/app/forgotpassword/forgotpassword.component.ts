import { Component } from '@angular/core';
import { NgForm } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { catchError } from 'rxjs/operators';
import { throwError } from 'rxjs';
import { environment } from 'src/environments/environment';
import { Router } from '@angular/router';

@Component({
  selector: 'app-forgotpassword',
  templateUrl: './forgotpassword.component.html',
  styleUrls: ['./forgotpassword.component.scss']
})
export class ForgotPasswordComponent {
  apiCheckEmail = `${environment.apiUrl}forgot/check-email`;
  apiSendOtp = `${environment.apiUrl}forgot/send-otp`;

  email: string = '';
  emailError: string = '';

  // ✅ Added popup states
  errorMessage: string = '';
  successMessage: string = '';
  showPopup: boolean = false;

  constructor(private http: HttpClient, private router: Router) {}

  onSubmit(form: NgForm) {
    this.emailError = '';
    this.errorMessage = '';
    this.successMessage = '';

    if (!form.valid) {
      this.emailError = 'Please enter a valid email';
      return;
    }

    // Step 1: Check email
    this.http.post<any>(this.apiCheckEmail, { email: this.email }).pipe(
      catchError(err => {
        this.emailError = 'Server error';
        return throwError(() => err);
      })
    ).subscribe(() => {
      // Always proceed to send OTP — backend never reveals if an email exists (#3 user enumeration)
      {
        // Step 2: Send OTP
        this.http.post<any>(this.apiSendOtp, { email: this.email }).subscribe({
          next: (res) => {
            if (res.blocked) {
              // 🚫 User exceeded 3 attempts
              this.errorMessage = "Too many OTP attempts. Please contact Administrator.";
              this.showPopup = true;
              return;
            }
            if (res.success) {
              // ✅ Save email for OTP component
              localStorage.setItem('userEmail', this.email);
              this.successMessage = "OTP sent to your registered email.";
              this.showPopup = true;

              setTimeout(() => {
                this.router.navigate(['/otp1']); // Navigate after showing popup
              }, 1500);
            } else {
              this.errorMessage = res.message || "Failed to send OTP";
              this.showPopup = true;
            }
          },
          error: () => {
            this.errorMessage = "Server error. Please try again later.";
            this.showPopup = true;
          }
        });
      }
    });
  }

  // ✅ Added popup close handler
  closePopup(): void {
    this.showPopup = false;
  }
}
