/**
 * Per-vertical pain points, KPIs, and Anyreach value propositions.
 * Injected into the message generation prompt so the LLM writes
 * messages that speak to the contact's actual world — not generic features.
 */

export const VERTICAL_KPIS = {
  contactcenter: {
    painPoints: 'Long hold times, high agent turnover, rising cost-per-call, inconsistent CX across channels',
    kpis: 'Cost per interaction, first-call resolution, average handle time, CSAT, agent utilization',
    anyreachValue: 'Resolve 50-80% of routine inquiries autonomously with AI voice agents. Cut cost-per-call by 60%. Deploy in 4 weeks with native Genesys/Five9/NICE integrations.',
  },
  dental: {
    painPoints: 'Missed calls during procedures, no-shows, staffing shortages, manual charting eating chair time',
    kpis: 'Chair utilization, patient no-show rate, new patient bookings, documentation time per exam',
    anyreachValue: 'AI phone agent answers every call 24/7 — books appointments, confirms insurance, reduces no-shows by 35%. Hands-free voice charting cuts documentation 70%.',
  },
  automotive: {
    painPoints: 'Missed service calls, slow lead follow-up, BDC staffing costs, after-hours inquiries going unanswered',
    kpis: 'Lead response time, service appointment fill rate, BDC cost per appointment, customer retention rate',
    anyreachValue: 'AI voice agent handles service scheduling and sales inquiries 24/7. Cut BDC costs 50% while responding to internet leads in under 60 seconds.',
  },
  logistics: {
    painPoints: 'Carrier check calls flooding dispatch, shipment status inquiries, driver communication gaps, after-hours emergencies',
    kpis: 'On-time delivery rate, cost per load, dispatch efficiency, carrier response time',
    anyreachValue: 'AI voice agent handles carrier check calls and shipment status updates 24/7. Free up dispatchers for high-value loads. Cut inbound call volume 40%.',
  },
  propertymanagement: {
    painPoints: 'Tenant maintenance requests at all hours, leasing inquiry response delays, high call volume during turnover season',
    kpis: 'Occupancy rate, maintenance response time, leasing conversion rate, tenant satisfaction score',
    anyreachValue: 'AI phone agent takes maintenance requests, answers leasing inquiries, and schedules showings 24/7. Boost occupancy 5-10% by never missing a prospect call.',
  },
  realestate: {
    painPoints: 'Agents miss buyer calls during showings, slow lead follow-up, admin eating into selling time',
    kpis: 'Lead-to-appointment rate, days on market, agent productivity, response time to new inquiries',
    anyreachValue: 'AI voice agent qualifies and routes buyer/seller inquiries instantly. Agents never miss a hot lead again. 3x more appointments booked with zero added headcount.',
  },
  healthcare: {
    painPoints: 'Patient call abandonment, scheduling bottlenecks, staff burnout from phone volume, no-shows',
    kpis: 'Patient no-show rate, call abandonment rate, scheduling fill rate, revenue per provider',
    anyreachValue: 'AI phone agent handles scheduling, prescription refill requests, and insurance verification 24/7. Reduce no-shows 30% with automated reminders. Cut front-desk call load 60%.',
  },
  recruiting: {
    painPoints: 'Candidate ghosting, slow screening for high-volume roles, recruiter time wasted on unqualified applicants',
    kpis: 'Time to fill, cost per hire, candidate response rate, submittals per recruiter',
    anyreachValue: 'AI voice agent screens candidates 24/7 — confirms availability, verifies qualifications, schedules interviews. Double submittals per recruiter. Cut time-to-fill 40%.',
  },
  homeservices: {
    painPoints: 'Missed calls while on jobs, seasonal demand spikes, manual dispatching, after-hours emergencies',
    kpis: 'Booked jobs per day, call-to-booking rate, average ticket size, customer acquisition cost',
    anyreachValue: 'AI phone agent books jobs and dispatches techs 24/7. Never lose a call to voicemail again. Home services companies recover $5K+/month in missed bookings.',
  },
  restaurants: {
    painPoints: '80% of calls unanswered during peak, lost orders from missed calls, multilingual callers, reservation chaos',
    kpis: 'Orders captured per shift, reservation fill rate, average ticket size, caller satisfaction',
    anyreachValue: 'AI voice agent takes orders and reservations 24/7 in 30+ languages. Recovers $4K+/month in missed orders. 15% avg ticket increase via smart upsells.',
  },
  agencies: {
    painPoints: 'Client churn from slow response, talent stretched across too many accounts, reporting eating billable hours',
    kpis: 'Client retention rate, revenue per employee, billable utilization, new business close rate',
    anyreachValue: 'White-label AI voice agents for your clients — add a new revenue stream. Automate client reporting and intake calls. Boost billable utilization 20%.',
  },
  msp: {
    painPoints: 'Tier 1 tickets overwhelming help desk, after-hours alerts going unacknowledged, client onboarding bottlenecks',
    kpis: 'Tickets per technician, first-response time, client satisfaction (CSAT), revenue per endpoint',
    anyreachValue: 'AI voice agent triages and resolves Tier 1 tickets 24/7 — password resets, connectivity checks, ticket logging. Cut help desk load 45%. Faster SLA response.',
  },
  saas: {
    painPoints: 'Support ticket backlogs, churn from slow resolution, onboarding friction, scaling support without linear headcount',
    kpis: 'Net revenue retention, support ticket resolution time, CSAT, cost per support interaction',
    anyreachValue: 'AI voice + chat agent resolves 60% of support tickets autonomously. Cut resolution time from hours to minutes. Scale support without scaling headcount.',
  },
  technology: {
    painPoints: 'Customer support scaling challenges, multilingual client base, after-hours technical inquiries',
    kpis: 'Support resolution time, customer satisfaction, support cost ratio, engineering escalation rate',
    anyreachValue: 'AI-powered support in 30+ languages handles technical triage 24/7. Reduce engineering escalations 35%. Scale global support without regional teams.',
  },
  ecommerce: {
    painPoints: 'Cart abandonment, order status call volume, return/exchange friction, peak season support surges',
    kpis: 'Cart abandonment rate, customer lifetime value, cost per order, return rate',
    anyreachValue: 'AI voice agent handles order status, returns, and product questions 24/7. Recover 10-15% of abandoned carts with proactive outreach. Cut support costs 50% during peak.',
  },
  communications: {
    painPoints: 'High churn in competitive market, technical support costs, provisioning delays, outage notification burden',
    kpis: 'Subscriber churn rate, cost per support call, net promoter score, average revenue per user',
    anyreachValue: 'AI voice agent handles billing inquiries, technical troubleshooting, and plan changes 24/7. Reduce churn 15% with proactive retention calls.',
  },
  financial: {
    painPoints: 'Compliance-heavy client communication, advisor time spent on routine inquiries, after-hours client needs',
    kpis: 'Assets under management growth, client retention rate, advisor productivity, compliance audit score',
    anyreachValue: 'AI voice agent handles appointment scheduling, account balance inquiries, and document requests with full compliance logging. Free advisors for high-value conversations.',
  },
  education: {
    painPoints: 'Enrollment inquiry backlogs, low yield rates, financial aid question overload, international student communication barriers',
    kpis: 'Enrollment yield rate, inquiry-to-application rate, student satisfaction, cost per enrolled student',
    anyreachValue: 'AI voice agent answers enrollment and financial aid questions 24/7 in 30+ languages. Boost yield rate 10-20% by engaging every inquiry within minutes.',
  },
  energy: {
    painPoints: 'High call volume during outages, billing dispute overload, field service coordination inefficiency',
    kpis: 'Customer satisfaction during outages, first-call resolution, average call handle time, field dispatch efficiency',
    anyreachValue: 'AI voice agent handles outage updates, billing inquiries, and service scheduling 24/7. Cut call center volume 50% during storm events.',
  },
  insurance: {
    painPoints: 'Policy renewal follow-up bottleneck, claims intake phone volume, quoting delays losing prospects',
    kpis: 'Policy renewal rate, quote-to-bind ratio, claims processing time, customer retention rate',
    anyreachValue: 'AI voice agent handles claims intake, policy questions, and renewal reminders 24/7. Boost renewal rate 15% with proactive outreach. Quote turnaround under 2 minutes.',
  },
  travel: {
    painPoints: 'Booking inquiries at all hours, multilingual guest needs, reservation changes and cancellations, seasonal staffing gaps',
    kpis: 'Booking conversion rate, RevPAR, guest satisfaction score, front desk call volume',
    anyreachValue: 'AI concierge handles reservations, guest requests, and local recommendations 24/7 in 30+ languages. Boost direct bookings 20%. Cut front desk call load 55%.',
  },
  retail: {
    painPoints: 'Store-level phone calls going unanswered, inconsistent customer experience across locations, inventory inquiry overload',
    kpis: 'Same-store sales growth, customer satisfaction, inventory turnover, foot traffic conversion',
    anyreachValue: 'AI voice agent answers store calls 24/7 — checks inventory, handles returns, drives foot traffic. Consistent CX across every location without added staff.',
  },
};

export function getVerticalKpis(key) {
  return VERTICAL_KPIS[key] || null;
}
