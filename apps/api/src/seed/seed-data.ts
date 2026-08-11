import type { TicketCategory, TicketPriority, TicketStatus } from "@helpdesk/contracts";

/**
 * Fixture pools for `./index.ts`.
 *
 * Data only — no Prisma, no randomness, no side effects. `seed.ts` owns the
 * PRNG and the writes; this file owns *what a helpdesk actually looks like*.
 *
 * Everything here is deliberately concrete. A reviewer scanning the list page is
 * the first audience for this data, and 63 rows of `Lorem ipsum` say nothing
 * about whether the product works. See `docs/features/Seed_Data.md`.
 */

/* ------------------------------------------------------------------ *
 * People
 * ------------------------------------------------------------------ */

export interface SeedRequester {
  name: string;
  /** Stored lowercase — `requesterEmail` filtering is a case-sensitive exact match. */
  email: string;
}

/**
 * Recurring requesters, so `?requesterEmail=` returns a plausible set of four or
 * five tickets rather than exactly one.
 */
export const REQUESTERS: readonly SeedRequester[] = [
  { name: "Amara Okafor", email: "amara.okafor@northwind.example" },
  { name: "Ben Halvorsen", email: "ben.halvorsen@northwind.example" },
  { name: "Chloe Marchetti", email: "chloe.marchetti@northwind.example" },
  { name: "Dev Ramanathan", email: "dev.ramanathan@northwind.example" },
  { name: "Elena Fischer", email: "elena.fischer@northwind.example" },
  { name: "Farouk Aziz", email: "farouk.aziz@northwind.example" },
  { name: "Grace Whitmore", email: "grace.whitmore@northwind.example" },
  { name: "Hana Yoshida", email: "hana.yoshida@northwind.example" },
  { name: "Ivan Petrov", email: "ivan.petrov@northwind.example" },
  { name: "Jasmine Boateng", email: "jasmine.boateng@northwind.example" },
  { name: "Kieran Walsh", email: "kieran.walsh@northwind.example" },
  { name: "Lucia Moreau", email: "lucia.moreau@northwind.example" },
  { name: "Marcus Steele", email: "marcus.steele@northwind.example" },
  { name: "Nadia Karim", email: "nadia.karim@northwind.example" },
  { name: "Oliver Brandt", email: "oliver.brandt@northwind.example" },
] as const;

/**
 * The IT side. Short list on purpose: the assignee filter is populated from
 * `GET /tickets/facets`, and eight options is enough to show that it works
 * without turning the dropdown into a directory.
 */
export const ASSIGNEES: readonly string[] = [
  "Priya Nair",
  "Tom Delgado",
  "Sofia Lindqvist",
  "Raj Chaudhary",
  "Mei-Ling Chen",
  "Daniel Osei",
  "Vera Kowalski",
  "Jonas Bergmann",
] as const;

/* ------------------------------------------------------------------ *
 * Tickets
 * ------------------------------------------------------------------ */

export interface SeedTicketTemplate {
  title: string;
  description: string;
  /** `null` exercises the "uncategorised" path, which the API allows. */
  category: TicketCategory | null;
  /**
   * A severity floor for issues where a random `low` would read as wrong — a
   * site-wide outage is not a low-priority ticket. `undefined` means "let the
   * weighted draw decide".
   */
  minPriority?: TicketPriority;
}

/**
 * Exactly one template per ticket, so no two seeded tickets share a title.
 * Duplicated titles make paging and sorting screenshots ambiguous ("is that the
 * same row twice, or did the page not change?").
 */
export const TICKET_TEMPLATES: readonly SeedTicketTemplate[] = [
  {
    title: "Printer on floor 3 jams on duplex jobs",
    description:
      "The Xerox by the north stairwell jams roughly every third double-sided job. Single-sided printing is fine. Two people have already pulled paper out of the rear tray this week.",
    category: "hardware",
  },
  {
    title: "SSO redirect loop after password reset",
    description:
      "After resetting my password I get bounced between the login page and the dashboard indefinitely. Clearing cookies fixes it for about an hour, then it starts again.",
    category: "access",
    minPriority: "high",
  },
  {
    title: "Laptop battery drains overnight while shut down",
    description:
      "ThinkPad T14, shut down at 100% on Friday, opened Monday at 6%. It is warm to the touch in the bag, so something seems to be waking it up.",
    category: "hardware",
  },
  {
    title: "Shared drive S: disconnects every morning",
    description:
      "The mapped drive shows a red cross until I manually reconnect. It only affects the finance share, not the general one.",
    category: "network",
  },
  {
    title: "Outlook search returns no results for last month",
    description:
      "Searching for anything older than about four weeks returns nothing, even for messages I can see by scrolling. Rebuilding the index from the control panel did not help.",
    category: "email",
  },
  {
    title: "VPN drops after exactly two hours",
    description:
      "The client disconnects at the two hour mark every time, including on a wired connection at home. Reconnecting works immediately, so it looks like a session timeout.",
    category: "network",
    minPriority: "high",
  },
  {
    title: "Request: Figma licence for the design team",
    description:
      "We have three designers sharing one seat. Requesting two additional editor licences, cost centre 4420.",
    // Filed without a category. `category` is nullable and the uncategorised row
    // is a state every screen has to render, so the seed contains some.
    category: null,
    minPriority: "low",
  },
  {
    title: "Monitor flickers when docked",
    description:
      "The left-hand Dell monitor flickers roughly once a minute when the laptop is docked. Plugging the same cable straight into the laptop is fine.",
    category: "hardware",
  },
  {
    title: "Cannot access the payroll folder after department move",
    description:
      "I moved from Operations to Finance last week and still have my old group memberships. The payroll folder returns access denied.",
    category: "access",
  },
  {
    title: "Teams calls drop when screen sharing",
    description:
      "Audio and video cut out about ten seconds into any screen share, then the call ends. It happens on both the desktop app and the browser version.",
    category: "software",
  },
  {
    title: "New starter setup: Marketing, starts 3rd",
    description:
      "Please prepare a laptop, phone, and the standard Marketing group memberships for a new starter joining on the 3rd. Desk 2-14.",
    category: "access",
  },
  {
    title: "Email to external recipients bouncing with 550",
    description:
      "Messages to two of our suppliers bounce with a 550 rejection mentioning SPF. Internal mail and other external domains are fine.",
    category: "email",
    minPriority: "high",
  },
  {
    title: "Excel crashes when opening the forecast workbook",
    description:
      "The Q3 forecast workbook closes Excel entirely about five seconds after opening. Other workbooks of a similar size are fine. The file opens in the web version.",
    category: "software",
  },
  {
    title: "Desk phone has no dial tone",
    description:
      "The handset on desk 1-07 shows the extension but there is no dial tone and inbound calls go straight to voicemail. The network light on the back is solid.",
    category: "hardware",
  },
  {
    title: "Wi-Fi unusable in the east meeting rooms",
    description:
      "Rooms E1 to E4 drop to one bar and time out. Standing in the corridor outside is fine. It started after the ceiling work last month.",
    category: "network",
  },
  {
    title: "Password expiry warning never appeared",
    description:
      "My password expired without any warning email or on-screen prompt, and I was locked out on Monday morning before a client call.",
    category: "access",
  },
  {
    title: "Request: second monitor for the support desk",
    description:
      "The support desk is running one screen while handling both the queue and the phone system. Requesting one additional 24 inch monitor.",
    category: "hardware",
    minPriority: "low",
  },
  {
    title: "Shared mailbox not syncing on mobile",
    description:
      "The invoices@ shared mailbox appears on desktop Outlook but not on the phone app. Removing and re-adding the account did not bring it back.",
    category: "email",
  },
  {
    title: "CRM export times out at 30 seconds",
    description:
      "Exporting more than about 2,000 contacts fails with a gateway timeout. Smaller exports complete. This blocks the monthly reporting pack.",
    category: "software",
    minPriority: "high",
  },
  {
    title: "Docking station only charges intermittently",
    description:
      "The dock charges the laptop maybe one time in three. Re-seating the USB-C cable usually fixes it for the day.",
    category: "hardware",
  },
  {
    title: "Guest Wi-Fi password not working for visitors",
    description:
      "The printed guest password in reception is rejected. Visitors have been tethering to their phones all week.",
    category: "network",
  },
  {
    title: "Two-factor prompts on every single login",
    description:
      "The trust this device option does not stick, so I am prompted for a code every time I open the intranet. Other people on the team are not.",
    category: "access",
  },
  {
    title: "Calendar invites arriving hours late",
    description:
      "Invitations from outside the company arrive between two and six hours after they were sent, which means declined rooms and double bookings.",
    category: "email",
  },
  {
    title: "Antivirus blocking the deployment script",
    description:
      "The release script is quarantined as a potentially unwanted program on every build agent. It has been unchanged for eight months.",
    category: "software",
    minPriority: "high",
  },
  {
    title: "Keyboard keys sticking on the loaner laptop",
    description:
      "The E, D, and C keys on loaner unit LT-114 need a firm press to register. There is something sticky under them.",
    category: null,
    minPriority: "low",
  },
  {
    title: "Internal DNS not resolving the new subdomain",
    description:
      "reports.internal resolves from the office but not over VPN, so remote staff cannot reach the reporting tool at all.",
    category: "network",
    minPriority: "high",
  },
  {
    title: "Locked out after three failed attempts from an old phone",
    description:
      "An old handset with a saved password kept retrying and locked my account. The phone has been wiped, but I still cannot sign in.",
    category: "access",
  },
  {
    title: "Out of office keeps switching itself off",
    description:
      "I set an out of office through to the 20th and it turns itself off after a day or two. Set it three times last week.",
    category: "email",
    minPriority: "low",
  },
  {
    title: "PDF editor licence expired mid-contract",
    description:
      "The editor now opens in read-only mode and says the licence expired, although the renewal was processed in March.",
    category: "software",
  },
  {
    title: "Conference room display shows no signal over HDMI",
    description:
      "The large screen in the boardroom shows no signal from any laptop over HDMI. The wireless casting option still works.",
    category: "hardware",
  },
  {
    title: "Site-wide slowdown accessing the file server",
    description:
      "Opening anything on the file server takes 30 to 60 seconds for everyone in the building since about 09:15. Local files are fine.",
    category: "network",
    minPriority: "urgent",
  },
  {
    title: "Request: admin rights to install developer tooling",
    description:
      "Requesting local administrator rights on my workstation so I can install and update the SDKs the team uses. Manager has approved by email.",
    category: "access",
  },
  {
    title: "Distribution list missing three new joiners",
    description:
      "The all-engineering list is missing three people who joined this month, so they are not receiving the release notices.",
    category: "email",
    minPriority: "low",
  },
  {
    title: "Browser extension blocking the expenses portal",
    description:
      "The expenses portal shows a blank page until every extension is disabled. Narrowing it down one at a time did not identify a single culprit.",
    category: "software",
  },
  {
    title: "Headset microphone not detected on the dock",
    description:
      "The USB headset works when plugged into the laptop directly but does not appear as an input device through the dock.",
    category: "hardware",
    minPriority: "low",
  },
  {
    title: "Static IP conflict on the warehouse scanner",
    description:
      "The handheld scanner in goods-in reports an address conflict and drops off the network every few minutes, which stalls receiving.",
    category: "network",
    minPriority: "high",
  },
  {
    title: "Contractor account still active after end date",
    description:
      "A contractor whose engagement ended on the 30th can still sign in and open the project share. Please disable and audit the access.",
    category: "access",
    minPriority: "urgent",
  },
  {
    title: "Phishing email reported by four people this morning",
    description:
      "A message claiming to be a shared invoice went to at least four people in Finance. One reports clicking the link before realising.",
    category: "email",
    minPriority: "urgent",
  },
  {
    title: "Design software stuck on the loading screen",
    description:
      "The application opens to the splash screen and never gets further. Reinstalling made no difference; a colleague on the same version is fine.",
    category: "software",
  },
  {
    title: "Laptop fan running constantly at full speed",
    description:
      "The fan runs flat out from the moment it boots, even with nothing open, and the case is uncomfortably hot near the hinge.",
    category: "hardware",
  },
  {
    title: "Printer queue stuck with a job nobody can delete",
    description:
      "There is a 400 page job at the top of the queue that will not cancel, and everything behind it is stalled. Restarting the spooler did not clear it.",
    category: "hardware",
  },
  {
    title: "Cannot reach the reporting tool from the branch office",
    description:
      "Nobody at the branch office can load the reporting tool, though the head office can. Other internal sites are reachable from both.",
    category: "network",
    minPriority: "high",
  },
  {
    title: "MFA app lost with the old phone",
    description:
      "My phone was replaced and I no longer have the authenticator codes. I need the second factor reset so I can enrol the new device.",
    category: "access",
    minPriority: "high",
  },
  {
    title: "Mail rule moving legitimate messages to junk",
    description:
      "Messages from one of our largest customers land in junk. Adding them to safe senders has not stopped it happening.",
    category: "email",
  },
  {
    title: "Spreadsheet formulas recalculating very slowly",
    description:
      "A workbook that used to recalculate instantly now takes 20 to 30 seconds after any edit. Nothing about the file has changed.",
    category: "software",
    minPriority: "low",
  },
  {
    title: "Webcam shows a black image in every application",
    description:
      "The built-in camera shows black in Teams, in the camera app, and in the browser. The privacy shutter is open and the indicator light comes on.",
    category: "hardware",
  },
  {
    title: "Network drive quota reached for the marketing share",
    description:
      "Saving to the marketing share fails with a disk full message. The share reports 500 GB used of 500 GB, mostly video from last year's campaign.",
    category: "network",
  },
  {
    title: "New joiner cannot sign in on their first morning",
    description:
      "The account exists in the directory but sign-in fails with an unknown user error. They are sitting at their desk unable to start.",
    category: "access",
    minPriority: "urgent",
  },
  {
    title: "Attachments over 10 MB silently disappearing",
    description:
      "Large attachments are stripped without any warning to the sender or the recipient, so people believe the file was sent.",
    category: "email",
    minPriority: "high",
  },
  {
    title: "Time tracking app logs the wrong time zone",
    description:
      "Entries made in the afternoon are recorded against the previous day. The profile time zone is correct in the settings page.",
    category: "software",
  },
  {
    title: "Mouse cursor jumps randomly across the screen",
    description:
      "The pointer jumps several centimetres at a time while typing. It happens with two different mice, so it may be the trackpad.",
    category: "hardware",
    minPriority: "low",
  },
  {
    title: "Switch port down in the server room rack B",
    description:
      "Port 14 on the rack B switch shows no link. The device on the other end is powered and its own link light is off.",
    category: "network",
    minPriority: "high",
  },
  {
    title: "Request: read-only access to the analytics dashboard",
    description:
      "Requesting view-only access to the sales analytics dashboard for two team leads so they stop asking me to export screenshots.",
    category: "access",
    minPriority: "low",
  },
  {
    title: "Signature images broken in outgoing mail",
    description:
      "The logo in my signature shows as a red cross for recipients outside the company, though it looks correct when I compose.",
    category: "email",
    minPriority: "low",
  },
  {
    title: "Database client cannot connect through the proxy",
    description:
      "The client times out connecting to the staging database from the office network. The same connection string works from home.",
    category: "software",
    minPriority: "high",
  },
  {
    title: "Scanner produces blank pages",
    description:
      "The flatbed scanner in the copy room produces completely blank PDFs. The preview looks correct before scanning.",
    category: "hardware",
  },
  {
    title: "Slow file transfer between the two offices",
    description:
      "Copying a 2 GB folder between sites takes over an hour, where it used to take a few minutes. Both ends report a healthy link.",
    category: "network",
  },
  {
    title: "Group membership change not taking effect",
    description:
      "I was added to the project group four days ago and still cannot open the folder, even after signing out and back in.",
    category: "access",
  },
  {
    title: "Meeting room mailbox accepting double bookings",
    description:
      "The E2 room mailbox accepts overlapping bookings instead of declining them, so two teams keep arriving at once.",
    category: "email",
  },
  {
    title: "Application update failed and left it uninstalled",
    description:
      "An automatic update failed halfway and now the application is not present at all. The installer errors with a missing prerequisite.",
    category: "software",
  },
  {
    title: "Laptop will not wake from sleep",
    description:
      "Opening the lid gives a black screen and the only way back is a hard power off. It has happened four times in two days.",
    category: "hardware",
    minPriority: "high",
  },
  {
    title: "Unlabelled cable removed from the comms cupboard",
    description:
      "Someone appears to have unplugged an unlabelled cable in the second floor comms cupboard. Reporting it so it can be traced and labelled properly.",
    category: "other",
  },
  {
    title: "Noise complaint about the server room fans",
    description:
      "The server room fans have become noticeably louder over the past week and can be heard from the adjacent desks. Possibly worth checking before it fails.",
    category: "other",
    minPriority: "low",
  },
] as const;

/* ------------------------------------------------------------------ *
 * Distribution
 * ------------------------------------------------------------------ */

export interface Weighted<T> {
  value: T;
  weight: number;
}

/**
 * Roughly 40 / 25 / 20 / 15, per `docs/features/Seed_Data.md`. Weights rather
 * than exact quotas: a quota that always produces precisely 25 open tickets
 * makes a test that asserts "about 40%" pass for the wrong reason.
 */
export const STATUS_WEIGHTS: readonly Weighted<TicketStatus>[] = [
  { value: "open", weight: 40 },
  { value: "in_progress", weight: 25 },
  { value: "resolved", weight: 20 },
  { value: "closed", weight: 15 },
] as const;

/**
 * Weighted toward `medium`, with a handful of `urgent` — enough that sorting by
 * priority is visibly *not* alphabetical, which is the whole reason
 * `priorityRank` exists.
 */
export const PRIORITY_WEIGHTS: readonly Weighted<TicketPriority>[] = [
  { value: "low", weight: 20 },
  { value: "medium", weight: 45 },
  { value: "high", weight: 25 },
  { value: "urgent", weight: 10 },
] as const;

/** Comments per ticket: 0–6, mean ≈ 3. */
export const COMMENT_COUNT_WEIGHTS: readonly Weighted<number>[] = [
  { value: 0, weight: 10 },
  { value: 1, weight: 14 },
  { value: 2, weight: 18 },
  { value: 3, weight: 20 },
  { value: 4, weight: 16 },
  { value: 5, weight: 12 },
  { value: 6, weight: 10 },
] as const;

/** Share of tickets left unassigned, so `?assigneeIsNull=true` returns rows. */
export const UNASSIGNED_SHARE = 0.3;

/* ------------------------------------------------------------------ *
 * Comments
 * ------------------------------------------------------------------ */

/** Written by whoever is working the ticket. */
export const AGENT_COMMENTS: readonly string[] = [
  "Thanks for the report — picking this up now.",
  "Could you confirm whether this happens on the wired connection too?",
  "I can reproduce it on a spare machine, so it is not local to your profile.",
  "Raised with the vendor, reference NW-8842. Waiting on their response.",
  "Replacement part ordered, expected within three working days.",
  "Applied the workaround for now so you are not blocked while we investigate.",
  "This looks like the same root cause as the ticket from last month.",
  "Logs show the session ending at exactly the same interval each time.",
  "Scheduled the change for the maintenance window on Thursday evening.",
  "Closing the loop: the fix is live. Please shout if it comes back.",
  "I have escalated this to the network team as it is beyond the desk.",
  "Confirmed the group membership has replicated. Please sign out and back in.",
  "No change after the reboot, so I am ruling out the driver.",
  "Swapped the cable as a test and the fault followed the dock, not the laptop.",
];

/** Written by the person who raised it. */
export const REQUESTER_COMMENTS: readonly string[] = [
  "Just happened again, about ten minutes ago.",
  "Thanks — that has fixed it for today at least.",
  "Yes, it happens on the wired connection as well.",
  "Adding a screenshot of the error message to this ticket.",
  "No rush from my side, I have a workaround for now.",
  "This is blocking the month-end pack, so it is getting urgent.",
  "Two colleagues on my floor are seeing the same thing.",
  "It worked fine until the update last week.",
  "Sorry for the delay, I was out of the office.",
  "Confirmed working again, thank you for the quick turnaround.",
];

/* ------------------------------------------------------------------ *
 * Knobs
 * ------------------------------------------------------------------ */

/**
 * The seed value. Fixed so that two developers running `db:seed` see the same
 * 63 tickets and can compare screenshots and bug reports directly.
 *
 * **Chosen, not arbitrary.** Sixty-three draws from the weight tables above is a
 * small enough sample that an arbitrary seed lands well off the documented
 * shape — the first one tried produced 7 `in_progress` tickets against an
 * expectation of 16, which reads on the list page as "the in-progress filter is
 * broken". This value was picked by scanning for one whose *realised*
 * distribution matches `docs/features/Seed_Data.md`; `src/seed.test.ts` asserts
 * that realised distribution, so changing this constant is a test failure rather
 * than a silent drift.
 */
export const PRNG_SEED = 24_073;

/** How many tickets the seed creates. Asserted, not aspirational. */
export const SEED_TICKET_COUNT = 63;

/** `createdAt` is spread across this many days ending at "now". */
export const SEED_WINDOW_DAYS = 90;
