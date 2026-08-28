// The member wizard's question set — versioned so every review records the
// wording it was answered under. Plain English, no JE vocabulary: each
// question maps to one or more factor codes server-side; the member never
// sees factor names. Cues deliberately surface commonly under-claimed work
// (supervising students, de-escalating relatives, fixing the rota, the
// emotional load) so quiet members are not under-scored — and examples are
// band-neutral so they do not coach towards a target.

export const QUESTION_SET_VERSION = 'je-questions-v1';

export const QUESTION_GROUPS = [
  { id: 'job', label: 'Your job today' },
  { id: 'doing', label: 'What you actually do' },
  { id: 'evidence', label: 'Evidence' },
  { id: 'finish', label: 'Check and send' },
];

export const QUESTIONS = [
  {
    code: 'typical_day',
    group: 'doing',
    factors: [],
    prompt: 'Talk us through a typical shift or day, start to finish.',
    cue: 'Write it how you’d say it. Short answers are fine — we’re looking at what the job involves, not how it’s written.',
  },
  {
    code: 'communication_who',
    group: 'doing',
    factors: ['communication'],
    prompt: 'Who do you deal with in a normal week — and what are the hardest conversations you have to handle?',
    cue: 'Think about explaining things people don’t want to hear, calming someone down, persuading a colleague, breaking bad news, language barriers. People often forget: de-escalating distressed patients or relatives.',
  },
  {
    code: 'knowledge_needed',
    group: 'doing',
    factors: ['knowledge'],
    prompt: 'What would a new person need to know, or have trained in, to do your job safely on day one?',
    cue: 'Qualifications, registrations, courses — but also things only experience teaches. What could go wrong if they didn’t know it?',
  },
  {
    code: 'judgement_calls',
    group: 'doing',
    factors: ['analytical'],
    prompt: 'What kinds of decisions or judgement calls do you make, and what makes them tricky?',
    cue: 'Choosing between options, spotting when something isn’t right, working things out with incomplete information.',
  },
  {
    code: 'planning_organising',
    group: 'doing',
    factors: ['planning'],
    prompt: 'What do you have to plan, organise or juggle — for yourself or for others?',
    cue: 'Rotas, clinics, caseloads, ordering, events, projects. People often forget: being the person who quietly fixes the rota.',
  },
  {
    code: 'physical_precision',
    group: 'doing',
    factors: ['physical_skills'],
    prompt: 'Does your job need precise or skilled hands-on work — where speed or accuracy really matters?',
    cue: 'Injections, wound care, fine equipment, advanced keyboard work, driving. If it took practice or training to get good at, it counts.',
  },
  {
    code: 'resp_patient_care',
    group: 'doing',
    factors: ['patient_care'],
    prompt: 'Tell us about your part in patient or client care.',
    cue: 'Direct care, advice to patients or families, planning care, specialist input. Include care work you think of as “just the job”.',
    optional: true,
  },
  {
    code: 'resp_policy',
    group: 'doing',
    factors: ['policy_service'],
    prompt: 'Do you write, change or improve how things are done — procedures, protocols, the way the service runs?',
    cue: 'Suggesting changes counts; so does implementing them for your area.',
    optional: true,
  },
  {
    code: 'resp_money_equipment',
    group: 'doing',
    factors: ['finance_physical'],
    prompt: 'Are you responsible for money, equipment, stock or supplies?',
    cue: 'Ordering, budgets, looking after expensive kit, patients’ property, stock counts. People often forget: being the one who orders the stock.',
    optional: true,
  },
  {
    code: 'resp_supervising',
    group: 'doing',
    factors: ['hr'],
    prompt: 'Do you supervise, train, teach or check the work of anyone — staff, students, new starters?',
    cue: 'Mentoring students, induction for new starters, being in charge of a shift, appraisals. People often forget: supervising students “informally”.',
    optional: true,
  },
  {
    code: 'resp_records_systems',
    group: 'doing',
    factors: ['information'],
    prompt: 'Do you look after records, data or computer systems beyond your own notes?',
    cue: 'Databases, spreadsheets others rely on, formal minutes, reports, audits of records, maintaining a system.',
    optional: true,
  },
  {
    code: 'resp_research',
    group: 'doing',
    factors: ['research'],
    prompt: 'Are you involved in audits, surveys, research or trials?',
    cue: 'Clinical audits, patient surveys, research programmes, testing new equipment.',
    optional: true,
  },
  {
    code: 'autonomy',
    group: 'doing',
    factors: ['freedom_to_act'],
    prompt: 'Who checks your work — and what do you get on with entirely on your own?',
    cue: 'What happens when something unexpected comes up and no one senior is around? What do you decide without asking anyone?',
  },
  {
    code: 'physical_demands',
    group: 'doing',
    factors: ['physical_effort'],
    prompt: 'What does your body do all shift?',
    cue: 'Lifting, moving people, standing for hours, awkward positions, cramped spaces. Everyday strain counts, not just heavy lifting.',
  },
  {
    code: 'concentration_demands',
    group: 'doing',
    factors: ['mental_effort'],
    prompt: 'When does your job demand real concentration — and what interrupts it?',
    cue: 'Checking doses, monitoring several things at once, constant interruptions, deadlines, unpredictable workloads.',
  },
  {
    code: 'emotional_demands',
    group: 'doing',
    factors: ['emotional_effort'],
    prompt: 'What’s the hardest part of the job emotionally?',
    cue: 'Distressed patients or families, bad news, death, safeguarding, carrying a bad shift home. This work is often invisible — it counts here.',
  },
  {
    code: 'environment',
    group: 'doing',
    factors: ['working_conditions'],
    prompt: 'What conditions do you work in, and what do you put up with?',
    cue: 'Aggression, bodily fluids, infection risk, noise, heat and cold, lone working, being outdoors, all-day screen work.',
  },
  {
    code: 'duty_log',
    group: 'evidence',
    factors: [],
    prompt: 'What has changed, and when? List the duties you now do, roughly when each started, and how often.',
    cue: 'This becomes the heart of the formal request. One line per duty is fine.',
    optional: true,
  },
  {
    code: 'anything_else',
    group: 'evidence',
    factors: [],
    prompt: 'Anything else about your job you want looked at?',
    cue: 'If you’re not sure whether something matters — write it down. Deciding what matters is our job, not yours.',
    optional: true,
  },
];

export const QUESTION_CODES = new Set(QUESTIONS.map((q) => q.code));

export function questionsForFactor(factorCode) {
  return QUESTIONS.filter((q) => q.factors.includes(factorCode));
}
