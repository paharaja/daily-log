// Reference thresholds. Every number carries its source. Only sources opened at source are cited.

export const SOURCES = {
  nhsHigh: {
    title: 'NHS — High blood pressure',
    url: 'https://www.nhs.uk/conditions/high-blood-pressure/',
    reviewed: 'Page last reviewed 19 July 2024',
    retrieved: '2026-10-21',
    quote: '135/85 or higher when checked at home; 140/90 or higher when checked by a healthcare professional',
  },
  nhsLow: {
    title: 'NHS — Low blood pressure',
    url: 'https://www.nhs.uk/conditions/low-blood-pressure-hypotension/',
    reviewed: 'Page last reviewed 11 July 2023 — its next-review date (11 July 2026) has passed',
    retrieved: '2026-10-21',
    quote: 'Low blood pressure is a reading of less than 90/60mmHg.',
  },
  cdc: {
    title: 'CDC — About high blood pressure (reproduces ACC/AHA categories)',
    url: 'https://www.cdc.gov/high-blood-pressure/about/index.html',
    reviewed: 'Updated and reviewed 13 October 2026',
    retrieved: '2026-10-21',
  },
  cks: {
    title: 'NICE CKS — Hypertension: How should I diagnose hypertension?',
    url: 'https://cks.nice.org.uk/topics/hypertension/diagnosis/diagnosis/',
    reviewed: 'Last revised June 2026',
    retrieved: '2026-10-21 (retrieved by a reviewing AI; text confirmed from its session log)',
  },
};

export const UK = { homeSys: 135, homeDia: 85, clinicSys: 140, clinicDia: 90, lowSys: 90, lowDia: 60 };

// US ACC/AHA categories as reproduced by the CDC. Shown only behind a toggle.
export const US_ZONES = [
  { name: 'Normal', sys: [0, 120], dia: [0, 80], rule: 'under 120 and under 80' },
  { name: 'Elevated', sys: [120, 130], dia: [0, 80], rule: '120–129 and under 80' },
  { name: 'Stage 1', sys: [130, 140], dia: [80, 90], rule: '130–139 or 80–89' },
  { name: 'Stage 2', sys: [140, 181], dia: [90, 121], rule: '140 or higher or 90 or higher' },
  { name: 'Severe', sys: [181, 400], dia: [121, 400], rule: 'higher than 180 and/or higher than 120' },
];

// CKS home bands — quoted as reference beside a protocol average only; never drawn on single points
// and never used to name a stage (CKS stages also need a clinic reading).
export const CKS_TEXT = {
  stage1: 'CKS stage 1 requires clinic 140/90–159/99 mmHg AND a home (HBPM) average of 135/85–149/94 mmHg.',
  stage2: 'CKS stage 2 requires clinic 160/100 mmHg or higher (but less than 180/120) AND a home (HBPM) average of 150/95 mmHg or higher.',
  stage3: 'CKS stage 3 / severe: clinic systolic 180 mmHg or higher, or clinic diastolic 120 mmHg or higher.',
  protocol: 'CKS home monitoring: two consecutive seated readings at least 1 minute apart, twice daily (ideally morning and evening), for at least 4 days and ideally 7; discard the first day and average all remaining readings.',
};

export function threshold(reading) {
  return reading.context === 'clinic'
    ? { sys: UK.clinicSys, dia: UK.clinicDia, label: 'UK clinic threshold (140/90)' }
    : { sys: UK.homeSys, dia: UK.homeDia, label: 'UK home threshold (135/85)' };
}

// Factual chips for one reading. No advice.
export function chips(reading) {
  const t = threshold(reading);
  const out = [];
  if (reading.systolic >= t.sys || reading.diastolic >= t.dia) out.push({ kind: 'high', text: `above ${t.label}` });
  else out.push({ kind: 'ok', text: `below ${t.label}` });
  if (reading.systolic < UK.lowSys && reading.diastolic < UK.lowDia) out.push({ kind: 'low', text: 'below NHS low reading (90/60)' });
  if (isVeryHigh(reading)) out.push({ kind: 'severe', text: 'in CKS stage 3 range (≥180 or ≥120)' });
  return out;
}

export function isVeryHigh(r) {
  return r.systolic >= 180 || r.diastolic >= 120;
}

export const BANNER_TEXT = 'This reading is in the range NICE CKS uses for stage 3 / severe hypertension when measured in clinic: systolic 180 mmHg or higher, or diastolic 120 mmHg or higher.';

export function usZone(r) {
  if (r.systolic > 180 || r.diastolic > 120) return 'Severe';
  if (r.systolic >= 140 || r.diastolic >= 90) return 'Stage 2';
  if (r.systolic >= 130 || r.diastolic >= 80) return 'Stage 1';
  if (r.systolic >= 120) return 'Elevated';
  return 'Normal';
}
