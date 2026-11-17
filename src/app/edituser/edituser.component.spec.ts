import { ComponentFixture, TestBed } from '@angular/core/testing';
import { EditUserComponent } from './edituser.component';
import { HttpClientTestingModule } from '@angular/common/http/testing';
import { RouterTestingModule } from '@angular/router/testing';
import { FormsModule } from '@angular/forms';

describe('EditUserComponent', () => {
  let component: EditUserComponent;
  let fixture: ComponentFixture<EditUserComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      declarations: [EditUserComponent],
      imports: [HttpClientTestingModule, RouterTestingModule, FormsModule]
    }).compileComponents();

    fixture = TestBed.createComponent(EditUserComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create EditUserComponent', () => {
    expect(component).toBeTruthy();
  });
});
