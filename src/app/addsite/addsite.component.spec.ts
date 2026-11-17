import { ComponentFixture, TestBed } from '@angular/core/testing';
import { AddsiteComponent } from './addsite.component';
import { HttpClientTestingModule } from '@angular/common/http/testing';
import { FormsModule } from '@angular/forms';

describe('AddsiteComponent', () => {
  let component: AddsiteComponent;
  let fixture: ComponentFixture<AddsiteComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      declarations: [AddsiteComponent],
      imports: [HttpClientTestingModule, FormsModule]
    })
    .compileComponents();

    fixture = TestBed.createComponent(AddsiteComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create the Add Site component', () => {
    expect(component).toBeTruthy();
  });

  it('should have an initial empty site object', () => {
    expect(component.site.atmLatest).toBe('');
    expect(component.site.city).toBe('');
    expect(component.site.state).toBe('');
  });

  it('should fetch LHO and Vendor lists on init', () => {
    spyOn(component, 'fetchLHOList');
    spyOn(component, 'fetchVendorList');
    component.ngOnInit();
    expect(component.fetchLHOList).toHaveBeenCalled();
    expect(component.fetchVendorList).toHaveBeenCalled();
  });
});
