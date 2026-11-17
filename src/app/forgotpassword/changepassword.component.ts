import { Component, OnInit } from '@angular/core';
import { FormBuilder, FormGroup, Validators } from '@angular/forms';
import { Router } from '@angular/router';
import { HttpClient } from '@angular/common/http';
import { environment } from 'src/environments/environment';


@Component({
  selector: 'app-changepassword',
  templateUrl: './changepassword.component.html',
  styleUrls: ['./changepassword.component.scss']
})
export class ChangePasswordComponent1 implements OnInit {
  resetPasswordForm: FormGroup;
  showNewPassword: boolean = false;
  showConfirmPassword: boolean = false;

  passwordErrors: string[] = [];
  passwordMatchMessage: string = '';
  passwordError: string = '';
  passwordSuccess: string = '';
  showPasswordPopup: boolean = false;

  apiResetPassword = `${environment.apiUrl}forgot/reset-password`;

  constructor(private fb: FormBuilder, private http: HttpClient, private router: Router) {}

  ngOnInit(): void {
    this.resetPasswordForm = this.fb.group(
      {
        newPassword: ['', [Validators.required]],
        confirmPassword: ['', [Validators.required]]
      },
      { validators: this.passwordsMatch }
    );
  }

  get f() {
    return this.resetPasswordForm.controls;
  }

  passwordsMatch(formGroup: FormGroup) {
    const newPassword = formGroup.get('newPassword')?.value;
    const confirmPassword = formGroup.get('confirmPassword')?.value;
    return newPassword === confirmPassword ? null : { mismatch: true };
  }

  validatePasswords() {
    const pw = this.resetPasswordForm.get('newPassword')?.value || '';
    const errors: string[] = [];
    if (pw.length < 15) errors.push('At least 15 characters required');
    if (!/[A-Z]/.test(pw)) errors.push('At least one uppercase letter required');
    if (!/[a-z]/.test(pw)) errors.push('At least one lowercase letter required');
    if (!/[0-9]/.test(pw)) errors.push('At least one number required');
    if (!/[!@#$%^&*(),.?":{}|<>]/.test(pw)) errors.push('At least one special character required');
    this.passwordErrors = errors;
  }

  togglePasswordVisibility(field: 'new' | 'confirm') {
    if (field === 'new') this.showNewPassword = !this.showNewPassword;
    else this.showConfirmPassword = !this.showConfirmPassword;
  }

  checkPasswordMatch() {
    const pw = this.resetPasswordForm.get('newPassword')?.value;
    const cpw = this.resetPasswordForm.get('confirmPassword')?.value;

    if (!pw && !cpw) this.passwordMatchMessage = '';
    else if (pw === cpw) this.passwordMatchMessage = 'Passwords match';
    else this.passwordMatchMessage = 'Passwords do not match';
  }

  onNewPasswordChange() {
    this.validatePasswords();
    if (!this.resetPasswordForm.get('confirmPassword')?.value) {
      this.passwordMatchMessage = '';
      return;
    }
    this.checkPasswordMatch();
  }

  onConfirmPasswordChange() {
    this.checkPasswordMatch();
  }

  resetPassword() {
  this.passwordError = '';
  const newPassword = this.resetPasswordForm.get('newPassword')?.value;
  const confirmPassword = this.resetPasswordForm.get('confirmPassword')?.value;

  if (!newPassword || !confirmPassword) {
    this.passwordError = 'Please fill both password fields';
    return;
  }

  if (newPassword !== confirmPassword) {
    this.passwordError = 'Passwords do not match';
    return;
  }

  this.validatePasswords();
  if (this.passwordErrors.length > 0) {
    this.passwordError = 'Password does not meet the required rules';
    return;
  }

  // Send the signed reset token to prove OTP was verified (#4 Weak Password Reset)
  const resetToken = localStorage.getItem('resetToken');
  if (!resetToken) {
    this.passwordError = 'Session expired. Please restart the password reset flow.';
    return;
  }

  this.http.post<any>(this.apiResetPassword, { newPassword, resetToken })
    .subscribe({
      next: res => {
        // Clear the one-time reset token immediately after use
        localStorage.removeItem('resetToken');

        this.passwordSuccess = 'Password reset successfully';
        this.showPasswordPopup = true;

        if (res.password_last_updated) {
          localStorage.setItem('password_last_updated', res.password_last_updated);
        }

        this.router.navigate(['/login']);
      },
      error: () => {
        this.passwordError = 'Server error. Please try again.';
        this.showPasswordPopup = true;
      }
    });
}

}
