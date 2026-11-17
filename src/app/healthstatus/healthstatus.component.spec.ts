import { ComponentFixture, TestBed } from '@angular/core/testing';
import { HealthStatusComponent } from './healthstatus.component';

describe('HealthStatusComponent', () => {
  let component: HealthStatusComponent;
  let fixture: ComponentFixture<HealthStatusComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      declarations: [HealthStatusComponent]
    }).compileComponents();

    fixture = TestBed.createComponent(HealthStatusComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('should render a table with header columns', () => {
    const compiled = fixture.nativeElement as HTMLElement;
    const headers = compiled.querySelectorAll('th');
    expect(headers.length).toBe(14);
  });

  it('should render at least one row of data', () => {
    const compiled = fixture.nativeElement as HTMLElement;
    const rows = compiled.querySelectorAll('tbody tr');
    expect(rows.length).toBeGreaterThan(0);
  });
});
