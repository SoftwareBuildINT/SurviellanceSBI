import { Component, OnInit } from '@angular/core';
import { FormBuilder, FormGroup, Validators } from '@angular/forms';
import { Router } from '@angular/router';
import { AuthService } from '../services/auth.service';

@Component({
  selector: 'app-changepassword',
  templateUrl: './changepassword.component.html',
  styleUrls: ['./changepassword.component.scss']
})

export class ChangePasswordComponent implements OnInit {
  // 👁️ Password visibility toggles
  showOldPassword: boolean = false;
  showNewPassword: boolean = false;
  showConfirmPassword: boolean = false;

  changePasswordForm: FormGroup;
  showPopup: boolean = false;
  popupMessage: string = '';
  isSuccessPopup: boolean = false; // Track if it's a success popup

  constructor(
    private fb: FormBuilder,
    private authService: AuthService,
    private router: Router
  ) { }

  ngOnInit(): void {
    this.changePasswordForm = this.fb.group(
      {
        oldPassword: ['', Validators.required],
        newPassword: [
          '',
          [
            Validators.required,
            Validators.pattern(
              /^(?=.*[A-Z])(?=.*[a-z])(?=.*\d)(?=.*[\W_]).{15,}$/
            )
          ]
        ],
        confirmPassword: ['', Validators.required]
      },
      { validators: this.passwordsMatch }
    );
  }

  // Getter for easy access to form fields
  get f() {
    return this.changePasswordForm.controls;
  }

  // Custom validator to check if newPassword and confirmPassword match
  passwordsMatch(formGroup: FormGroup) {
    const newPassword = formGroup.get('newPassword')?.value;
    const confirmPassword = formGroup.get('confirmPassword')?.value;
    return newPassword === confirmPassword ? null : { mismatch: true };
  }

  // Show popup with a message
  showPopupMessage(message: string, isSuccess: boolean): void {
    this.popupMessage = message;
    this.isSuccessPopup = isSuccess;
    this.showPopup = true;
  }

  // Close the popup and redirect if it's a success popup
  closePopup(): void {
    this.showPopup = false;
    if (this.isSuccessPopup) {
      setTimeout(() => {
        this.router.navigate(['/login']); // Redirect to login page after success
      }, 500); // Short delay before redirecting
    }
  }

  // Submit handler for the form
  onSubmit(): void {
    if (this.changePasswordForm.invalid) {
      return;
    }

    const { oldPassword, newPassword } = this.changePasswordForm.value;
    const userId = localStorage.getItem('userId'); // Assuming userId is stored after login

    if (!userId) {
      this.showPopupMessage('User not authenticated', false);
      return;
    }

    this.authService.changePassword(oldPassword, newPassword, userId).subscribe(
      (res) => {
        this.showPopupMessage('Password changed successfully!', true);
      },
      (err) => {
        this.showPopupMessage('Error changing password: ' + err.error.msg, false);
      }
    );
  }
}
