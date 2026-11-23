import type { DemoThreadSpec } from "./helpers";
import {
  SARAH_CHEN,
  BILL_LUMBERGH,
  CHEN_LIU,
  DANA_WHITFIELD,
  TOM_REYES,
  NINA_PATEL,
  SAM_PATEL,
} from "./people";
import { PRIORITY } from "./labels";

export const SALES_THREADS: DemoThreadSpec[] = [
  {
    id: "demo-thread-sales-001",
    subject: "ACME × Northwind: pricing for the 2026 rollout",
    labelIds: ["IMPORTANT", "Pipeline/Q2", "Customers/Northwind", PRIORITY.NEEDS_REPLY],
    isStarred: true,
    messages: [
      {
        from: SARAH_CHEN,
        at: { days: 2, time: "15:22" },
        html: `<p>Hi John,</p>
<p>Following up on our call last Thursday. The team is excited about the Q2 timeline. Could you send over the enterprise tier pricing for ~250 seats with SSO and the audit log add-on?</p>
<p>Best,<br/>Sarah Chen<br/>VP Operations, Northwind Labs</p>`,
      },
      {
        from: "me",
        to: SARAH_CHEN.email,
        at: { days: 1, time: "08:47" },
        html: `<p>Hi Sarah,</p>
<p>Great to hear. Attached is the enterprise deck. Pricing for 250 seats with SSO + audit logs comes to <strong>$84,000/year</strong> with the annual prepay discount.</p>
<p>Want to jump on a call this week to walk through? Tuesday 2pm PT?</p>
<p>- John</p>`,
        attachments: [
          {
            filename: "acme-enterprise-pricing-2026.pdf",
            mimeType: "application/pdf",
            size: 482_000,
          },
        ],
      },
      {
        from: SARAH_CHEN,
        at: { days: 0, time: "09:14" },
        isRead: false,
        html: `<p>Thanks John,</p>
<p>The team reviewed the deck. Two questions:</p>
<ol>
  <li>Does the SSO add-on support SCIM provisioning out of the box, or is that a separate line item?</li>
  <li>For the audit log, what's the retention default? Our compliance team is asking about 7-year retention specifically.</li>
</ol>
<p>Tuesday 2pm PT works for the call. I'll send an invite.</p>
<p>Sarah</p>`,
      },
    ],
  },
  {
    id: "demo-thread-sales-002",
    subject: "Quick demo this week?",
    labelIds: ["Pipeline/Q2"],
    messages: [
      {
        from: DANA_WHITFIELD,
        at: { days: 0, time: "11:02" },
        isRead: false,
        html: `<p>Hi John,</p>
<p>Caught your talk at the SaaStr meetup last week, really sharp framing on the analytics layer story. We've been evaluating tools for our new data team and ACME keeps coming up.</p>
<p>Could we get a 30-min demo this week? I'm free Wed/Thu afternoon PT.</p>
<p>Dana Whitfield<br/>Director of Data, Umbrella Co</p>`,
      },
    ],
  },
  {
    id: "demo-thread-sales-003",
    subject: "Re: Renewal - Globex contract",
    labelIds: ["IMPORTANT", "Customers/Globex", PRIORITY.NEEDS_REPLY],
    messages: [
      {
        from: CHEN_LIU,
        at: { days: 4, time: "10:30" },
        html: `<p>Hey John,</p>
<p>Our renewal comes up end of next month. The exec team wants to bump us from the Growth plan to Enterprise. We're hitting the seat cap and the workspace admin team needs the audit features.</p>
<p>What does the upgrade path look like? Mid-cycle prorate or wait until renewal?</p>
<p>Chen</p>`,
      },
      {
        from: "me",
        to: CHEN_LIU.email,
        at: { days: 3, time: "17:15" },
        html: `<p>Hey Chen,</p>
<p>Either works. Cleanest is the mid-cycle prorate: we credit you for the unused Growth time and start Enterprise immediately. Total comes out to ~$11,200 net to upgrade now, then full Enterprise pricing on renewal.</p>
<p>Want me to send a quote?</p>
<p>John</p>`,
      },
      {
        from: CHEN_LIU,
        at: { days: 3, time: "18:02" },
        html: `<p>Quick one before I loop in procurement: does the prorate credit cover the two add-ons we bought in March, or just the base plan?</p>
<p>Chen</p>`,
      },
      {
        from: "me",
        to: CHEN_LIU.email,
        at: { days: 3, time: "18:40" },
        html: `<p>It covers both. The add-ons prorate on the same schedule as the base plan, so the ~$11,200 already includes them.</p>
<p>John</p>`,
      },
      {
        from: CHEN_LIU,
        at: { days: 2, time: "07:45" },
        html: `<p>Great. Procurement wants the quote on our vendor template and a W-9. Can you do both?</p>
<p>Chen</p>`,
      },
      {
        from: "me",
        to: CHEN_LIU.email,
        at: { days: 2, time: "08:20" },
        html: `<p>Sure. Send the template over and I'll fill it in today. I'll attach the W-9 with the quote.</p>
<p>John</p>`,
      },
      {
        from: CHEN_LIU,
        at: { days: 2, time: "09:00" },
        isRead: false,
        html: `<p>Template's attached. Send the quote whenever it's ready, we'd like to sign this week if we can.</p>
<p>Chen</p>`,
      },
    ],
  },
  {
    id: "demo-thread-sales-004",
    subject: "Hooli evaluation: SOC2 + DPA documents",
    labelIds: ["Pipeline/Q2", PRIORITY.NEEDS_FOLLOW_UP],
    priorityReason: "Security review materials were sent and the Hooli evaluation is still active.",
    messages: [
      {
        from: TOM_REYES,
        at: { days: 5, time: "14:12" },
        html: `<p>John,</p>
<p>Security review starting on our end. Can you send across:</p>
<ul>
  <li>Latest SOC 2 Type II report</li>
  <li>Standard DPA template (we'll redline)</li>
  <li>Subprocessor list</li>
</ul>
<p>Aiming for a yes/no decision by end of next week.</p>
<p>Tom Reyes<br/>Head of Security, Hooli</p>`,
      },
      {
        from: "me",
        to: TOM_REYES.email,
        at: { days: 5, time: "16:45" },
        html: `<p>Tom,</p>
<p>All three attached. The SOC 2 covers our Sept '25 audit period; we re-cert in February. DPA is the standard one we use with all enterprise customers.</p>
<p>Anything missing, let me know.</p>
<p>- John</p>`,
        attachments: [
          {
            filename: "acme-soc2-type2-sept2025.pdf",
            mimeType: "application/pdf",
            size: 1_140_000,
          },
          {
            filename: "acme-dpa-v3.pdf",
            mimeType: "application/pdf",
            size: 264_000,
          },
          {
            filename: "acme-subprocessors.pdf",
            mimeType: "application/pdf",
            size: 88_000,
          },
        ],
      },
    ],
  },
  {
    id: "demo-thread-sales-005",
    subject: "Loved the demo, next steps?",
    labelIds: ["Pipeline/Q2"],
    messages: [
      {
        from: NINA_PATEL,
        at: { days: 1, time: "07:48" },
        isRead: false,
        html: `<p>John,</p>
<p>Thanks for walking us through the dashboard yesterday. The cohort drill-down piece is exactly what we've been missing. Our CTO was sold by the second slide.</p>
<p>What's the path to a paid pilot? We'd like to start with our growth team (~12 users) for a month and expand from there.</p>
<p>Nina Patel<br/>VP Growth, Wonka Industries</p>`,
      },
    ],
  },
  {
    id: "demo-thread-sales-006",
    subject: "Re: Initech POC scope",
    labelIds: ["Customers/Initech"],
    messages: [
      {
        from: BILL_LUMBERGH,
        at: { days: 6, time: "11:30" },
        html: `<p>Yeah, hi John,</p>
<p>So we're gonna need you to scope the POC a little differently. We'd like to add the segments API to the eval. Mmkay?</p>
<p>Thaaanks.</p>
<p>Bill</p>`,
      },
      {
        from: "me",
        to: BILL_LUMBERGH.email,
        at: { days: 6, time: "12:01" },
        html: `<p>No problem, Bill. Adding segments API to the POC scope. Sending the updated SOW shortly.</p>
<p>John</p>`,
      },
    ],
  },
  {
    id: "demo-thread-sales-007",
    subject: "Northwind procurement form",
    labelIds: ["Customers/Northwind", "Pipeline/Q2"],
    messages: [
      {
        from: SARAH_CHEN,
        at: { days: 7, time: "09:50" },
        html: `<p>Hi John, our procurement team needs this form filled out before we can issue the PO. Sorry, I know it's a slog. Let me know if you want to hop on a call to do it together.</p>
<p>Sarah</p>`,
        attachments: [
          {
            filename: "northwind-vendor-intake-2026.pdf",
            mimeType: "application/pdf",
            size: 224_000,
          },
        ],
      },
    ],
  },
  {
    id: "demo-thread-sales-008",
    subject: "Don't see you in HubSpot, sync issue?",
    labelIds: [],
    archived: true,
    messages: [
      {
        from: SAM_PATEL,
        at: { days: 9, time: "16:22" },
        html: `<p>John, quick one: HubSpot isn't showing the Globex renewal as won. I marked it manually but the sync looks broken. Can someone on eng take a look?</p>
<p>Sam</p>`,
      },
    ],
  },
  {
    id: "demo-thread-sales-009",
    subject: "Champion intro: Maya at Hooli infrastructure",
    labelIds: ["Pipeline/Q2", PRIORITY.NEEDS_FOLLOW_UP],
    priorityReason: "John asked for an intro call after the champion handoff and should follow up.",
    messages: [
      {
        from: TOM_REYES,
        at: { days: 11, time: "13:14" },
        html: `<p>John, meet Maya Lin, she runs platform engineering at Hooli. She'll be the primary technical evaluator on the contract.</p>
<p>Maya, John runs ACME. He's been great to work with so far, happy to introduce you.</p>
<p>Tom</p>`,
      },
      {
        from: "me",
        to: "maya.lin@hooli.example.com",
        cc: TOM_REYES.email,
        at: { days: 11, time: "14:02" },
        html: `<p>Maya, great to meet you, and thanks for the intro Tom. Free for a quick intro call this week or next? I'd love to learn how your team is thinking about analytics rollout at Hooli scale.</p>
<p>John</p>`,
      },
    ],
  },
  {
    id: "demo-thread-sales-010",
    subject: "Re: Pricing question for 50 seats",
    labelIds: [],
    archived: true,
    messages: [
      {
        from: {
          name: "Ravi Singh",
          email: "ravi@stark-industries.example.com",
          photoUrl: "/demo/avatars/generic-org.svg",
        },
        at: { days: 14, time: "10:11" },
        html: `<p>Quick question: for 50 seats on the Growth plan, what's the annual price?</p>`,
      },
      {
        from: "me",
        to: "ravi@stark-industries.example.com",
        at: { days: 14, time: "10:30" },
        html: `<p>Hi Ravi, 50 seats on Growth comes to $24,000/yr ($40/seat/mo billed annually). Happy to set up a 14-day trial if helpful.</p>
<p>John</p>`,
      },
    ],
  },
  {
    id: "demo-thread-sales-011",
    subject: "Demo no-show, reschedule?",
    labelIds: [],
    messages: [
      {
        from: DANA_WHITFIELD,
        at: { days: 8, time: "11:45" },
        html: `<p>Hi John, really sorry I missed our call this morning, something came up with our CFO on short notice. Could we reschedule to next week? Tuesday or Wednesday afternoon would work.</p>
<p>Dana</p>`,
      },
    ],
  },
  {
    id: "demo-thread-sales-012",
    subject: "Re: Globex annual review prep",
    labelIds: ["Customers/Globex"],
    messages: [
      {
        from: CHEN_LIU,
        at: { days: 10, time: "09:30" },
        html: `<p>John, annual review next Friday. Sending over the slide template our CRO uses. The numbers I care about:</p>
<ul>
  <li>Active workspaces (we have 14 now, started with 3)</li>
  <li>Queries/month trend</li>
  <li>Time-to-insight metric you mentioned on the last call</li>
</ul>
<p>If you have ideas for the "future state" slide, I'm all ears.</p>
<p>Chen</p>`,
      },
    ],
  },
  {
    id: "demo-thread-sales-013",
    subject: "Procurement followup: invoice terms",
    labelIds: ["Customers/Northwind"],
    archived: true,
    messages: [
      {
        from: {
          name: "Procurement",
          email: "procurement@northwindlabs.example.com",
          photoUrl: "/demo/avatars/generic-org.svg",
        },
        at: { days: 18, time: "14:00" },
        html: `<p>Vendor: please confirm Net 60 payment terms and provide W-9 for our records before we can process payment.</p>`,
      },
      {
        from: "me",
        to: "procurement@northwindlabs.example.com",
        at: { days: 17, time: "08:15" },
        html: `<p>Net 60 confirmed. W-9 attached.</p>`,
        attachments: [
          {
            filename: "acme-w9-2026.pdf",
            mimeType: "application/pdf",
            size: 42_000,
          },
        ],
      },
    ],
  },
  {
    id: "demo-thread-sales-014",
    subject: "Are you the right person for partnerships?",
    labelIds: [],
    messages: [
      {
        from: {
          name: "Alicia Romero",
          email: "alicia@stark-industries.example.com",
          photoUrl: "/demo/avatars/generic-org.svg",
        },
        at: { days: 3, time: "12:01" },
        isRead: false,
        html: `<p>Hi John,</p>
<p>I lead partnerships at Stark Industries. We're rebuilding our internal data platform and we'd love to chat about a co-marketing/integration partnership with ACME. We've got 800 mutual customers in our CDP, so it's a really natural fit.</p>
<p>Worth 20 minutes?</p>
<p>Alicia</p>`,
      },
    ],
  },
  {
    id: "demo-thread-sales-015",
    subject: "POC results: analytics speed comparison",
    labelIds: ["Pipeline/Q2", PRIORITY.NEEDS_REPLY],
    messages: [
      {
        from: TOM_REYES,
        at: { days: 1, time: "17:30" },
        isRead: false,
        html: `<p>John,</p>
<p>POC results in. Side-by-side with our current vendor on the same dataset (12B events, 90d window):</p>
<table border="0" cellpadding="6" style="border-collapse:collapse;">
  <tr><th align="left">Query</th><th align="left">Current</th><th align="left">ACME</th></tr>
  <tr><td>Cohort retention (30d)</td><td>11.4s</td><td>1.8s</td></tr>
  <tr><td>Funnel breakdown</td><td>22.1s</td><td>3.2s</td></tr>
  <tr><td>Custom segment scan</td><td>timed out</td><td>4.7s</td></tr>
</table>
<p>Numbers speak for themselves. Let's set up a security review and pricing conversation.</p>
<p>Tom</p>`,
      },
    ],
  },
];
