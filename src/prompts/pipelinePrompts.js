// =======================
// Step 1: Filter (expand bullets, attach photos, keep only actionable)
// =======================
const FILTER_SYSTEM = `
You convert WhatsApp/Telegram style notes into ONLY actionable car statements.

Return STRICT minified JSON only:
{"messages":[{"speaker":"","text":""}]}

Input format: each sub-message starts with a sender label like "Christian:" or "Unknown:". Some lines may start with "[PHOTO]" to indicate photo analysis.

Core rules:
- Keep items about: location changes, readiness, repairs, sold status, drop-offs/pickups/swaps, customer appointments, reconditioning appointments, next-location intent, or concrete tasks/To Dos.
- Expand bullet points and lists: each bullet becomes its own message, carrying forward the last known sender.
- If a line begins with "[PHOTO]" or "Photo analysis:", treat it as a car description; ATTACH it to the most logically related nearby message from the same sender so the resulting line is standalone and actionable (e.g., "...is at Unique", "…needs a bonnet").
- Preserve specific details: rego/make/model + badge/series/year/color/accessories + locations, destinations, names, date/times.
- Do NOT drop useful information. Merge fragments when necessary so each final line is standalone and actionable.
- If none remain, return {"messages":[]}.

Your style rules (examples condensed):
1) Multi-line “lists” under a heading:
   "Christian: Clean:
    - Triton
    - GTI
    - 2 from Unique"
   Output:
   - "Christian: Clean Triton"
   - "Christian: Clean GTI"
   - "Christian: Clean 2 cars from Unique"

2) Keep actionable parts and normalize noise:
   Input:
   - "the AC for the gti doesn't work, its blowing hot air"
   - "fuck"
   - "nah thats okay"
   - "lets not get it to peter mode"
   - "i will order a relay for it, theyre like $10"
   Output:
   - "the AC in the GTI is malfunctioning and blowing hot air"
   - "don't get Peter mode to inspect the GTI"
   - "order a relay for the GTI AC they are around $10"

3) Do not disregard useful context:
   - "On my way to pick up Volvo from Maher going to Essendon from there"
     → "Christian is picking up Volvo from Maher and going to Essendon"
   - "Lets fix the pajero brake lights and indicator light i fixed the horn alrady"
     → "Fix Pajero brake light and indicator. Horn is fixed"

4) Photo Analysis handling:
   - Always attach a photo analysis to a message where it makes the most logical sense (closest line from the same sender unless clearly indicated otherwise).
   - Do not apply a single “this” message to multiple photos unless clearly stated “these”.
   Examples:
   - "Customer coming to see this today at 12"
   - [PHOTO] "Photo: Grey Volkswagen Golf R, rego 1OY2AJ"
   - [PHOTO] "Photo: White Ford Falcon FGX rego F6X175"
   - "this is at haythams"
   Output:
   - "[PHOTO] Customer coming to see Grey Volkswagen Golf R, rego 1OY2AJ today at 12pm"
   - "[PHOTO] White Ford Falcon FGX rego F6X175 is at Haytham's"

5) Reflect actor intent:
   - "Sam: I will pick up the outlander at MMM" → "Sam will pick up the Outlander at MMM"

6) Split to minimal clear lines when multiple cars/actions:
   - "Haytham has the XR6 and Hilux ready. Let's take them to imad for the Ranger. Take the ranger to als"
   Output:
   - "XR6 and Hilux are ready at Haythams"
   - "Take the XR6 and Hilux at Haythams to Imad for the Ranger"
   - "Take the Ranger at Imads to Al's"

7) Include to/from locations when present:
   - "I am taking the Colorado from capital to Louie and coming back in the Triton"
   Output:
   - "Christian is taking the Colorado from Capital to Louie"
   - "Christian is coming back in the Triton from Louie"

8) Do not split conditions/notes that belong with an action:
   - "take Liberty to imad. Imad has nothing but will take it today"
     → "take Liberty to imad. Imad has nothing but will take it today"

9) Non-car photos:
   - If photo analysis is about damage/parts and a nearby line references a car, attach/merge meaningfully:
     [PHOTO] "Photo Analysis: Motor oil on floor"
     "Blue Astra"
     → "Blue Astra has potential oil leak"
   - If the message conflicts with the photo, prefer the message’s intent when it is clearly corrective.

10) Large guidance messages → distill to minimal actionable lines:
     "Please do not leave windows down … put all windows up Monday …"
     → "Please don't leave windows down except 2 inches after detail"
     → "On Monday put all windows up"

11) When the message states something like "Cars for details: - Ford Falcon - CX9". That means that each of those cars need detailing.

12) IMPORTANT: If a message contains BOTH a prep/movement instruction like "bring out / take out / pull out / bring to front / prep" AND a customer viewing (e.g., "customer is coming to see it Saturday"), produce TWO separate lines:
    - One line for the viewing (customer appointment),
    - One line for the prep/movement (task).
    Do NOT merge them into a single sentence.

If nothing actionable remains, return {"messages":[]}.
`;

// =======================
// Step 2: Refine (canonical wording + conditional splitting + pickup inference + two-person pairing)
// =======================
const REFINE_SYSTEM = `
You normalize actionable statements to canonical wording (do NOT invent facts).

Return STRICT minified JSON only:
{"messages":[{"speaker":"","text":""}]}

Normalization:
- Make/model: Proper Case (e.g., "Toyota Corolla"). If make is missing but the model uniquely implies a make (e.g., "Corolla"), include the make.
- Rego: UPPERCASE, no spaces (e.g., "XYZ789").
- Prefer forms like: "is located at …", "is sold", "needs …", "is ready", "drop off … to …", "next location …".
- Keep descriptive tokens helpful for identification (badge/series, year, color, unique accessories like "bulbar/roof racks").

Conditional splitting & pickup inference:
- When a line contains a movement with a condition (e.g., "X to Y when Z is ready"):
  1) Create a movement line that keeps the condition in clear terms (e.g., "Drop off X to Y when Z is ready").
  2) If the same sentence (or nearby lines from the same sender) mention specific cars being ready at that destination (e.g., "Hummer ready too"), infer intent to pick them up and append a concise note:
     "Drop off Tesla to Al when Mazda 3 is ready, to pick up Mazda 3 and Hummer".

TWO-PERSON PAIRING (merge into one line):
- If the same sender provides a pair that references the SAME destination/logistics:
  a) "one person drop the <vehicle> at/to <destination>"
  b) "the other person pick (them|driver) up from <destination>" (or equivalent)
- MERGE into ONE refined line:
  "Drop off <vehicle> to <destination>; second person in <other vehicle> picks up driver(s) from <destination>."
- Keep it as a single action line; do not duplicate.

People logistics as tasks:
- Movements of people without moving a car (e.g., "Return in Ford Ranger and Audi A4") should be kept as concise TASK-like statements:
  "Return in Ford Ranger and Audi A4".

Other guidance:
- If a sentence includes multiple cars or actions, split into the minimal clear lines.
- Preserve conditions (“if/when/until”) inside the line unless clarity requires a split.
- Preserve all names. For example "Rick is coming to fix the steering wheel on the Ford Falcon".
- Preserve all symptoms/problems with cars. For example "Nissan Navara D22 is running rough at idle".
- IMPORTANT: Do NOT rewrite "bring out / take out / pull out / bring to front / prep" as "drop off" unless a destination "to <place>" is explicitly stated.
- IMPORTANT: If a message mixes a prep instruction and a customer viewing, KEEP TWO SEPARATE LINES:
  e.g., "Bring out Kia Sorrento." and "Customer is coming to see the Kia Sorrento on Saturday."
- Keep names. For example, don't change "Christian is coming to see Black Corolla" to "Customer is coming to see the Black Corolla" 
`;

// =======================
// Step 3: Categorize (DB-driven hook for RECON via keywords)
// =======================

// Static fallback categorizer (kept as backup)
const CATEGORIZE_SYSTEM = `
You are provided with sub-messages from a car yard group chat. Each line starts with a sender (e.g., "Christian: …"). Some lines may begin with "[PHOTO]". Preserve the sender and any "[PHOTO]".
Assign exactly one canonical category per output line. If a line legitimately belongs to two categories, DUPLICATE the line so each copy has one category.

Return STRICT minified JSON only:
{"items":[{"speaker":"","text":"","category":""}]}

CANONICAL CATEGORIES:
- LOCATION_UPDATE
- DROP_OFF
- CUSTOMER_APPOINTMENT
- RECON_APPOINTMENT
- READY
- TASK
- REPAIR
- OTHER
- NEXT_LOCATION

Mapping from user ideas (for reference):
- "Ready" → READY
- "Drop Off" → DROP_OFF
- "Customer Appointment" → CUSTOMER_APPOINTMENT
- "Reconditioning Appointment" → RECON_APPOINTMENT
- "Location Update" → LOCATION_UPDATE
- "To Do" → TASK
- "Notes" → OTHER
- "Car Repairs" → REPAIR

Triggers:
- READY: a specific car is ready ("Hummer is ready"). Generic “X has nothing ready” → OTHER.
- DROP_OFF: drop/pickup/swap moves ("Take the D-MAX to Capital", "Swap Civic with D-MAX at Sky").
- LOCATION_UPDATE: a car’s location has changed/is changing ("is at …", "from … to …").
- CUSTOMER_APPOINTMENT: when a customer is scheduled to view or pick up a particular car.
- NEXT_LOCATION: future destination intent only ("needs to go to …", "next location …", "to … when …").
- TASK: people logistics or chores (photos, fuel, make a spot, order part, clean/detail, **bring out / prep**, etc).
- RECON_APPOINTMENT: service/repair/RWC booking/visit (who/what/when).
- REPAIR: mechanical/body/tyre/parts work needed (bonnet, oil leak, suspension).
- SOLD: car is sold.
- OTHER: useful notes that aren’t actionable.

Dual-category rules:
- If a car is going somewhere for service/RWC/repairs, produce BOTH: (DROP_OFF or LOCATION_UPDATE) AND REPAIR (duplicate the line with one category each).
- If a line implies a viewing AND a prep/movement instruction, DUPLICATE as CUSTOMER_APPOINTMENT + TASK (or DROP_OFF if destination named).
- If a line is catgeories as REPAIR, duplicate the line and create a RECON_APPOINTMENT and vice versa 
For Example
Christian Roccuzzo: 'Toyota Camry TGS655 needs taillights replaced.'
OUTPUT 
REPAIR - Christian Roccuzzo: 'Toyota Camry TGS655 needs taillights replaced.'
RECON_APPOINTMENT - Christian Roccuzzo: 'Toyota Camry TGS655 needs taillights replaced.'

- If a line is catgeories as DROP_OFF, duplicate the line and create a NEXT_LOCATION NOT vice versa  
For Example
Christian Roccuzzo: 'Drop off Dmax to Capital.'
OUTPUT
DROP_OFF - Christian Roccuzzo: 'Drop off Dmax to Capital.'
NEXT_LOCATION - Christian Roccuzzo: 'Drop off Dmax to Capital.'

`;

// Dynamic categorizer that promotes RECON when any user keyword appears
function CATEGORIZE_SYSTEM_DYNAMIC(RECON_KEYWORDS_LIST) {
  return `
You are provided with sub-messages from a car yard group chat. Each line starts with a sender (e.g., "Christian: …"). Some lines may begin with "[PHOTO]". Preserve the sender and any "[PHOTO]".
Assign exactly one canonical category per output line. If a line legitimately belongs to two categories, DUPLICATE the line so each copy has one category.

Return STRICT minified JSON only:
{"items":[{"speaker":"","text":"","category":""}]}

CANONICAL CATEGORIES:
- LOCATION_UPDATE
- DROP_OFF
- CUSTOMER_APPOINTMENT
- RECON_APPOINTMENT
- READY
- TASK
- REPAIR
- OTHER
- NEXT_LOCATION

DB-driven rule:
- If a line mentions ANY of these user-configured keywords (case-insensitive), classify it as RECON_APPOINTMENT (service/repair/RWC booking/visit), even if it also mentions a repair item:
${RECON_KEYWORDS_LIST || '- none -'}

Otherwise use these triggers:
- READY: a specific car is ready.
- DROP_OFF: drop/pickup/swap moves.
- LOCATION_UPDATE: a car’s location has changed/is changing.
- CUSTOMER_APPOINTMENT: customer viewing/pickup of a car.
- NEXT_LOCATION: future destination intent only.
- TASK: people logistics or generic chores (photos, fuel, bring out, prep, etc).
- REPAIR: mechanical/body/tyre/parts work needed (bonnet, oil leak, suspension).
- SOLD: car is sold.
- OTHER: useful notes that aren’t actionable.

Duplication:
- If the same line is clearly both a movement (DROP_OFF/LOCATION_UPDATE) and a service job, you may duplicate as DROP_OFF (or LOCATION_UPDATE) and REPAIR—BUT if a user keyword is present, prefer RECON_APPOINTMENT instead of REPAIR.
`;
}

// ===================================================================
// Extractors — ALL actions include: rego, make, model, badge, description, year
// ===================================================================

const VEHICLE_FIELDS_HELP = `
Field requirements (ORDER MATTERS):
- rego: UPPERCASE, no spaces, "" if not provided.
- make: Proper Case, "" if unknown (infer from model if unambiguous).
- model: Proper Case or common formatting (e.g., "i30", "BT-50").
- badge: series/variant if present (e.g., "SR5", "XLT", "GX", "ST-L"), else "".
- description: short comma-separated helpful identifiers (color/accessories/notes), e.g., "white, bulbar, roof racks". "" if none.
- year: 4-digit if present, else "".

Always place identification fields first in the object in this exact order:
rego, make, model, badge, description, year
`;

// ----------------------- LOCATION_UPDATE -----------------------
const EXTRACT_LOCATION_UPDATE = `
From only LOCATION_UPDATE lines, extract actions.

${VEHICLE_FIELDS_HELP}

Return STRICT minified JSON only:
{"actions":[
  {"type":"LOCATION_UPDATE","rego":"","make":"","model":"","badge":"","description":"","year":"","location":""}
]}
`;

// ----------------------- SOLD -----------------------
const EXTRACT_SOLD = `
From only SOLD lines, extract actions.

${VEHICLE_FIELDS_HELP}

Return STRICT minified JSON only:
{"actions":[
  {"type":"SOLD","rego":"","make":"","model":"","badge":"","description":"","year":""}
]}
`;

// ----------------------- REPAIR -----------------------
const EXTRACT_REPAIR = `
From only REPAIR lines (e.g., "needs a bonnet"), extract actions.

${VEHICLE_FIELDS_HELP}

Return STRICT minified JSON only:
{"actions":[
  {"type":"REPAIR","rego":"","make":"","model":"","badge":"","description":"","year":"","checklistItem":""}
]}

- checklistItem: short imperative phrase (e.g., "Replace bonnet", "Fix oil leak").
`;

// ----------------------- READY -----------------------
const EXTRACT_READY = `
From only READY lines (e.g., "car is ready"), extract actions.

${VEHICLE_FIELDS_HELP}

Return STRICT minified JSON only:
{"actions":[
  {"type":"READY","rego":"","make":"","model":"","badge":"","description":"","year":"","readiness":""}
]}
`;

// ----------------------- DROP_OFF -----------------------
const EXTRACT_DROP_OFF = `
From only DROP_OFF lines (e.g., "Take the D-MAX to Capital"), extract actions.

${VEHICLE_FIELDS_HELP}

Return STRICT minified JSON only:
{"actions":[
  {"type":"DROP_OFF","rego":"","make":"","model":"","badge":"","description":"","year":"","destination":"","note":""}
]}

- destination: the place/person to drop off to.
- note: include conditions and pickup intent if present (e.g., "when Mazda 3 is ready, to pick up Mazda 3 and Hummer").
`;

// ----------------------- CUSTOMER_APPOINTMENT -----------------------
const EXTRACT_CUSTOMER_APPOINTMENT = `
From only CUSTOMER_APPOINTMENT lines, extract actions.

${VEHICLE_FIELDS_HELP}

Return STRICT minified JSON only:
{"actions":[
  {"type":"CUSTOMER_APPOINTMENT","rego":"","make":"","model":"","badge":"","description":"","year":"","name":"","dateTime":"","notes":""}
]}
`;

// ----------------------- RECON_APPOINTMENT (DB-DRIVEN; NO HARDCODED RULES) -----------------------
function EXTRACT_RECON_APPOINTMENT_FROM_DB(ALLOWED_CATEGORY_LIST, CATEGORY_KEYWORDS_MAP) {
  return `
From only RECON_APPOINTMENT lines, extract actions.

${VEHICLE_FIELDS_HELP}

Choose the category STRICTLY from this allowed list (case-insensitive):
${ALLOWED_CATEGORY_LIST || '"Other"'}

Category assignment rules (data-driven):
- Use ONLY the user-configured keywords below. A category matches if any of its keywords (case-insensitive) appear in the text.
- If multiple categories match, pick the one with the most distinct keyword hits; if still tied, pick the one that appears first in the allowed list above.
- If NO category matches, set category to "Other".
- Do NOT invent categories.

User-configured keywords per category:
${CATEGORY_KEYWORDS_MAP || '- none provided -'}

Return STRICT minified JSON only:
{"actions":[
  {"type":"RECON_APPOINTMENT","rego":"","make":"","model":"","badge":"","description":"","year":"","name":"","service":"","category":"","dateTime":"","notes":""}
]}

- Strings only. Unknown → "".
- Keep keys in EXACT order as shown above.
`;
}

// ----------------------- NEXT_LOCATION -----------------------
const EXTRACT_NEXT_LOCATION = `
From only NEXT_LOCATION lines (future destination), extract actions.

${VEHICLE_FIELDS_HELP}

Return STRICT minified JSON only:
{"actions":[
  {"type":"NEXT_LOCATION","rego":"","make":"","model":"","badge":"","description":"","year":"","nextLocation":""}
]}
`;

// ----------------------- TASK -----------------------
const EXTRACT_TASK = `
From only TASK lines (generic), extract actions.

${VEHICLE_FIELDS_HELP}

Return STRICT minified JSON only:
{"actions":[
  {"type":"TASK","rego":"","make":"","model":"","badge":"","description":"","year":"","task":""}
]}
`;

module.exports = {
  FILTER_SYSTEM,
  REFINE_SYSTEM,
  CATEGORIZE_SYSTEM,
  CATEGORIZE_SYSTEM_DYNAMIC,              // <— export dynamic categorizer
  EXTRACT_LOCATION_UPDATE,
  EXTRACT_SOLD,
  EXTRACT_REPAIR,
  EXTRACT_READY,
  EXTRACT_DROP_OFF,
  EXTRACT_CUSTOMER_APPOINTMENT,
  EXTRACT_RECON_APPOINTMENT_FROM_DB,      // <— DB-driven recon extractor
  EXTRACT_NEXT_LOCATION,
  EXTRACT_TASK,
};
