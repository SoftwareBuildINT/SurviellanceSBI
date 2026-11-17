import { ComponentFixture, TestBed } from '@angular/core/testing';

import { ITLDashboardComponent } from './itl-dashboard.component';

describe('ITLDashboardComponent', () => {
  let component: ITLDashboardComponent;
  let fixture: ComponentFixture<ITLDashboardComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ITLDashboardComponent]
    })
    .compileComponents();

    fixture = TestBed.createComponent(ITLDashboardComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
