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
  changePasswordForm: FormGroup;

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
              /^(?=.*[A-Z])(?=.*[a-z])(?=.*\d)(?=.*[\W_]).{8,16}$/
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

  // Submit handler for the form
  onSubmit(): void {
    if (this.changePasswordForm.invalid) {
      return;
    }

    const { oldPassword, newPassword } = this.changePasswordForm.value;
    const userId = localStorage.getItem('userId'); // Assuming userId is stored after login

    if (!userId) {
      alert('User not authenticated');
      return;
    }

    this.authService.changePassword(oldPassword, newPassword, userId).subscribe(
      (res) => {
        alert('Password changed successfully');
        this.router.navigate(['/login']); // Navigate to login or dashboard
      },
      (err) => {
        alert('Error changing password: ' + err.error.msg);
      }
    );
  }
}
