import { ComponentFixture, TestBed } from '@angular/core/testing';
import { FormsModule, NgForm } from '@angular/forms';
import { RouterTestingModule } from '@angular/router/testing';
import { ForgotPasswordComponent } from './forgotpassword.component';
import { By } from '@angular/platform-browser';
import { HttpClientTestingModule } from '@angular/common/http/testing';
import { DebugElement } from '@angular/core';

describe('ForgotPasswordComponent', () => {
  let component: ForgotPasswordComponent;
  let fixture: ComponentFixture<ForgotPasswordComponent>;
  let form: NgForm;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      declarations: [ForgotPasswordComponent],
      imports: [FormsModule, RouterTestingModule, HttpClientTestingModule]
    }).compileComponents();

    fixture = TestBed.createComponent(ForgotPasswordComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create the component', () => {
    expect(component).toBeTruthy();
  });

  it('should display error if form is invalid (empty email)', () => {
    component.email = '';
    const formEl = <NgForm>{
      valid: false,
    };

    component.onSubmit(formEl);
    expect(component.emailError).toBe('Please enter a valid email');
  });

  it('should call API if form is valid (mocked)', () => {
    component.email = 'test@example.com';

    const formEl = <NgForm>{
      valid: true,
    };

    // Spy on localStorage and router
    const localStorageSpy = spyOn(localStorage, 'setItem');
    const navigateSpy = spyOn((<any>component).router, 'navigate');

    // Mock the http response
    const http = TestBed.inject(HttpClientTestingModule);
    spyOn((<any>component).http, 'post').and.returnValue({
      pipe: () => ({
        subscribe: (callback: any) => {
          callback({ exists: true });
        }
      })
    });

    component.onSubmit(formEl);

    expect(component.emailError).toBe('');
    expect(localStorageSpy).toHaveBeenCalledWith('email', 'test@example.com');
    expect(navigateSpy).toHaveBeenCalledWith(['/otp1']);
  });

  it('should set error if email not registered', () => {
    component.email = 'test@example.com';

    const formEl = <NgForm>{
      valid: true,
    };

    spyOn((<any>component).http, 'post').and.returnValue({
      pipe: () => ({
        subscribe: (callback: any) => {
          callback({ exists: false });
        }
      })
    });

    component.onSubmit(formEl);
    expect(component.emailError).toBe('Email not registered');
  });

  it('should update email model when input value changes', () => {
    const input: HTMLInputElement = fixture.debugElement.query(By.css('input[name="email"]')).nativeElement;
    input.value = 'hello@example.com';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect(component.email).toBe('hello@example.com');
  });
});
