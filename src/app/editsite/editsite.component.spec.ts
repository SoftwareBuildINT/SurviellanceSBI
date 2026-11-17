import { ComponentFixture, TestBed } from '@angular/core/testing';
import { EditSiteComponent } from './editsite.component';
import { HttpClientTestingModule } from '@angular/common/http/testing';
import { FormsModule } from '@angular/forms';
import { RouterTestingModule } from '@angular/router/testing';
import { ActivatedRoute } from '@angular/router';
import { of } from 'rxjs';

describe('EditSiteComponent', () => {
  let component: EditSiteComponent;
  let fixture: ComponentFixture<EditSiteComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      declarations: [EditSiteComponent],
      imports: [
        HttpClientTestingModule,
        FormsModule,
        RouterTestingModule
      ],
      providers: [
        {
          provide: ActivatedRoute,
          useValue: {
            snapshot: {
              paramMap: {
                get: () => '1' // mock site id
              }
            }
          }
        }
      ]
    }).compileComponents();
  });

  beforeEach(() => {
    fixture = TestBed.createComponent(EditSiteComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create EditSiteComponent', () => {
    expect(component).toBeTruthy();
  });
});
