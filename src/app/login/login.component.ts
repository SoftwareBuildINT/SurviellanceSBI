import { Component } from '@angular/core';
import { Router } from '@angular/router';
import { DataService } from '../data.service';

@Component({
  selector: 'app-login',
  templateUrl: './login.component.html',
  styleUrls: ['./login.component.scss']
})
export class LoginComponent {
  username: string = '';
  password: string = '';
  errorMessage: string | null = null;
  showPopup: boolean = false;
  isLoading: boolean = false;

  constructor(
    private dataService: DataService,
    private router: Router
  ) { }

  // 🔥 Decode JWT payload
  decodeJwt(token: string): any {
    try {
      return JSON.parse(atob(token.split('.')[1]));
    } catch (e) {
      return null;
    }
  }

  onSubmit() {
    if (this.isLoading) {
      return;
    }

    const payload = {
      EmailId: this.username,
      password: this.password
    };

    this.isLoading = true;

    this.dataService.login(payload).subscribe(
      response => {
        if (response.success) {

          // ✔ Clear any stale final token so the auth guard cannot grant access before OTP
          localStorage.removeItem('token');

          // ✔ Save the temporary token (valid only during OTP stage, otpVerified: false)
          localStorage.setItem('tempToken', response.tempToken);

          // ✔ Decode userId & email from the tempToken
          const decoded = this.decodeJwt(response.tempToken);
          if (decoded) {
            localStorage.setItem('userEmail', decoded.email);
          }

          // ✔ Save role and user data needed on the OTP page
          localStorage.setItem('roleId', response.roleId);
          localStorage.setItem('lho_id', response.lho_id);
          localStorage.setItem('userId', String(response.userId));

          // ✔ Redirect to OTP page
          // store email so OTP page can find it
          localStorage.setItem('userEmail', this.username);

          // optionally pass it in navigation state
          this.router.navigate(['/otp'], { state: { email: this.username } });

          this.errorMessage = null;
          this.showPopup = false;

        } else {
          this.isLoading = false;
          this.errorMessage = response.message || 'Login failed. Please try again.';
          this.showPopup = false;
        }
      },
      error => {
        this.isLoading = false;
        console.error('Full error object:', error);

        if (error?.name === 'TimeoutError') {
          this.errorMessage = 'Login request timed out. Please check backend/API connectivity and try again.';
          this.showPopup = false;
          return;
        }

        if (error.error) {
          let message = '';
          let isContactAdminError = false;

          if (error.error.message) {
            message = error.error.message;

            if (
              message.includes('contact administrator') ||
              message.includes('Contact Administrator') ||
              error.error.error === 'Contact Administrator'
            ) {
              isContactAdminError = true;
            }

            if (
              error.error.attemptsLeft !== undefined &&
              error.error.attemptsLeft >= 0
            ) {
              message = `${message} You have ${error.error.attemptsLeft} attempts left.`;
            }

          } else if (error.error.error) {
            message = error.error.error;

            if (
              message.includes('contact administrator') ||
              message.includes('Contact Administrator')
            ) {
              isContactAdminError = true;
            }

          } else if (typeof error.error === 'string') {
            message = error.error;
          } else {
            message = 'Something went wrong. Please try again.';
          }

          this.errorMessage = message;
          this.showPopup = isContactAdminError;

        } else {
          this.errorMessage = 'Network error. Please check your connection and try again.';
          this.showPopup = false;
        }
      }
    );
  }



  openForgotPasswordPopup() {
    this.showPopup = true;
  }

  closePopup() {
    this.showPopup = false;
    this.errorMessage = null;
  }
}
