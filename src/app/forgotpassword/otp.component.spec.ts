import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ReactiveFormsModule } from '@angular/forms';
import { OtpComponent1 } from './otp.component';

describe('OtpComponent', () => {
  let component: OtpComponent1;
  let fixture: ComponentFixture<OtpComponent1>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      declarations: [OtpComponent1],
      imports: [ReactiveFormsModule]
    }).compileComponents();

    fixture = TestBed.createComponent(OtpComponent1);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create OTP component', () => {
    expect(component).toBeTruthy();
  });

  it('should be invalid when empty', () => {
    expect(component.otpForm.valid).toBeFalse();
  });

  it('should be valid when all inputs are filled with digits', () => {
    component.otpControls.forEach((ctrl, i) => ctrl.setValue(i));
    expect(component.otpForm.valid).toBeTrue();
  });
});
