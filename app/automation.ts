import automationConfig from "../mv82-4-automation-fields.json" with { type: "json" };

export type AutomationField = {
  key: string;
  label: string;
  group: string;
  inputType?: string;
  fillMode: "text" | "choice" | "dateParts" | "manual";
  allowBlank?: boolean;
  deriveFrom?: string;
  manualReason?: string;
  pdfHandlers: string[];
};

export type Purpose = { id: string; label: string; reviewFields: string[] };
export type CaseData = Record<string, string>;

export const AUTOMATION_FIELDS = automationConfig.fields as AutomationField[];
export const PURPOSES = automationConfig.purposes as Purpose[];
export const EMPTY_CASE_DATA: CaseData = Object.fromEntries(AUTOMATION_FIELDS.map((field) => [field.key, ""]));

export function mergeOrganizedDocuments(documents: Array<CaseData | null>, current: CaseData, manuallyEdited: Set<string>) {
  const merged = { ...EMPTY_CASE_DATA };
  const conflicts = new Set<string>();
  for (const field of AUTOMATION_FIELDS) {
    if (manuallyEdited.has(field.key)) {
      merged[field.key] = current[field.key] || "";
      continue;
    }
    const candidates = documents.map((document) => document?.[field.key]?.trim() || "").filter(Boolean);
    merged[field.key] = candidates[0] || "";
    const distinct = new Set(candidates.map((value) => value.replace(/\W/g, "").toUpperCase()));
    if (distinct.size > 1) conflicts.add(field.key);
  }
  return { merged, conflicts };
}

const clean = (value: string) => value.replace(/\s+/g, " ").replace(/^[:|\-\s]+|[:|\-\s]+$/g, "").trim();

export function normalizeOrganizedCustomerName(value: string) {
  const normalized = clean(value);
  if (!normalized) return "";
  const [lastName, ...remainingParts] = normalized.split(",");
  if (remainingParts.length) {
    const givenNames = clean(remainingParts.join(" ").replace(/,/g, " "));
    return givenNames ? `${clean(lastName)}, ${givenNames}` : clean(lastName);
  }
  const nameParts = normalized.split(" ").filter(Boolean);
  return nameParts.length > 1 ? `${nameParts[0]}, ${nameParts.slice(1).join(" ")}` : normalized;
}

export function pdfDownloadFilename(fullName: string, date = new Date()) {
  const safeName = clean(fullName)
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "")
    .replace(/[. ]+$/g, "") || "Customer";
  const dateStamp = [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
  return `${safeName} - ${dateStamp}.pdf`;
}

const firstMatch = (text: string, expression: RegExp, group = 1) => clean(text.match(expression)?.[group] || "");
const withoutTableSeparators = (value: string) => clean(value.replace(/\s*\|\s*/g, " "));
const FUEL_CODES = new Set(["G", "D", "E", "F", "C", "P", "N", "O"]);

const labelledValue = (text: string, labels: string[]) => {
  for (const label of labels) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const value = firstMatch(text, new RegExp(`${escaped}\\s*(?:NUMBER|NO\\.?|#)?\\s*[:|]?\\s*([^\\n|]{2,80})`, "i"));
    if (value) return value;
  }
  return "";
};

const toIsoDate = (value: string) => {
  const match = value.match(/\b(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})\b/);
  if (!match) return "";
  const year = match[3].length === 2 ? Number(match[3]) > 30 ? `19${match[3]}` : `20${match[3]}` : match[3];
  return `${year}-${match[1].padStart(2, "0")}-${match[2].padStart(2, "0")}`;
};

const KNOWN_MAKES = ["TOYOTA", "HONDA", "FORD", "CHEVROLET", "CHEVY", "NISSAN", "HYUNDAI", "KIA", "BMW", "MERCEDES", "LEXUS", "SUBARU", "MAZDA", "VOLKSWAGEN", "VOLVO", "JEEP", "DODGE", "RAM", "GMC", "ACURA", "INFINITI", "AUDI", "TESLA", "BUICK", "CADILLAC", "CHRYSLER", "LINCOLN", "MITSUBISHI", "PORSCHE", "LAND ROVER"];

const tableValueBeforeLabel = (lines: string[], label: string) => {
  const wanted = clean(label).toUpperCase();
  for (let index = 1; index < lines.length; index += 1) {
    const labels = lines[index].split("|").map((value) => clean(value).toUpperCase());
    const column = labels.indexOf(wanted);
    if (column < 0) continue;
    const values = lines[index - 1].split("|").map(clean);
    if (values[column]) return values[column];
  }
  return "";
};

export function inferCaseData(texts: string[]): CaseData {
  const text = texts.filter(Boolean).join("\n");
  const upper = text.toUpperCase();
  const upperLines = upper.split(/\r?\n/).map(clean).filter(Boolean);
  const inferred = { ...EMPTY_CASE_DATA };

  inferred.vin = firstMatch(upper, /\b([A-HJ-NPR-Z0-9]{17})\b/).replace(/\s/g, "");
  inferred.nysId = firstMatch(upper, /\b(\d{3}[\s-]?\d{3}[\s-]?\d{3})\b/).replace(/\D/g, "");

  const dobContext = firstMatch(upper, /(?:DATE OF BIRTH|\bDOB\b)[^\n]{0,45}?(\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4})/);
  inferred.dob = toIsoDate(dobContext);

  const labelledPlate = labelledValue(upper, ["CURRENT PLATE", "PLATE NUMBER", "PLATE NO"]);
  inferred.plate = firstMatch(labelledPlate, /\b([A-Z0-9]{3,10})\b/);

  const yearMakeLineIndex = upperLines.findIndex((line) => {
    const match = line.match(/^((?:19|20)\d{2})\s+([A-Z]{3,15})(?:\s|$)/);
    return Boolean(match && !["ISSUED", "EXPIRES", "EXPIRATION", "EFFECTIVE"].includes(match[2]));
  });
  const yearMake = yearMakeLineIndex >= 0
    ? upperLines[yearMakeLineIndex].match(/^((?:19|20)\d{2})\s+([A-Z]{3,15})(?:\s|$)/)
    : null;
  const labelledYear = firstMatch(labelledValue(upper, ["VEHICLE YEAR", "YEAR"]), /\b((?:19|20)\d{2})\b/);
  const tableYear = firstMatch(tableValueBeforeLabel(upperLines, "YEAR"), /\b((?:19|20)\d{2})\b/);
  const tableMake = firstMatch(tableValueBeforeLabel(upperLines, "MAKE"), /\b([A-Z0-9-]{2,15})\b/);
  inferred.year = tableYear || yearMake?.[1] || labelledYear || "";
  inferred.make = tableMake || yearMake?.[2] || KNOWN_MAKES.find((make) => new RegExp(`\\b${make}\\b`).test(upper)) || "";
  const registrationPlate = yearMakeLineIndex > 0
    ? upperLines.slice(Math.max(0, yearMakeLineIndex - 2), yearMakeLineIndex).reverse()
      .find((line) => /^(?=.*[A-Z])(?=.*\d)[A-Z0-9]{3,10}$/.test(line))
    : "";
  inferred.plate = inferred.plate || registrationPlate || "";

  const labelledName = labelledValue(text, ["NAME OF PRIMARY REGISTRANT", "PRIMARY REGISTRANT", "INSURED NAME", "NAME"]);
  const textLines = text.split(/\r?\n/).map(clean).filter(Boolean);
  const commaNameIndex = textLines.findIndex((line) => /^[A-Z][A-Z' -]+,\s*[A-Z][A-Z' -]+(?:,\s*[A-Z])?$/.test(line));
  const commaName = commaNameIndex >= 0 ? textLines[commaNameIndex] : "";
  const precedingSurname = commaNameIndex > 0 && /^[A-Z][A-Z' -]{1,30}$/.test(textLines[commaNameIndex - 1])
    ? textLines[commaNameIndex - 1]
    : "";
  const splitName = precedingSurname ? `${precedingSurname}, ${commaName.replace(/,/g, " ")}` : commaName;
  const streetLineIndex = textLines.findIndex((line) => /^\d{1,6}\s+.+\b(?:ST|STREET|RD|ROAD|DR|DRIVE|AVE|AVENUE|BLVD|BOULEVARD|LN|LANE|CT|COURT|PKWY|PLACE|PL)\b/i.test(line));
  const isUnlabelledNameLine = (line: string) => {
    const upperLine = line.toUpperCase();
    return /^[A-Z][A-Z' -]{1,39}$/.test(upperLine)
      && !/^(?:ID|DOB|ISSUED|EXPIRES|EXPIRATION|NAME|ADDRESS|DRIVER LICENSE)$/.test(upperLine);
  };
  const addressPrecedingName = streetLineIndex >= 2
    && isUnlabelledNameLine(textLines[streetLineIndex - 2])
    && isUnlabelledNameLine(textLines[streetLineIndex - 1])
    ? `${textLines[streetLineIndex - 2]}, ${textLines[streetLineIndex - 1]}`
    : "";
  inferred.fullName = clean(splitName || labelledName || addressPrecedingName || "");
  inferred.printedName = inferred.fullName;

  const streetMatch = upper.match(/\b(\d{1,6}\s+[A-Z0-9 .#'\-]+?\s(?:ST|STREET|RD|ROAD|DR|DRIVE|AVE|AVENUE|BLVD|BOULEVARD|LN|LANE|CT|COURT|PKWY|PLACE|PL)\b(?:\s*(?:#|APT\.?|UNIT)\s*[A-Z0-9-]+)?)/);
  if (streetMatch) {
    const fullStreet = clean(streetMatch[1]);
    const apartmentMatch = fullStreet.match(/\s+(?:#|APT\.?|UNIT)\s*([A-Z0-9-]+)$/);
    inferred.apartment = apartmentMatch?.[1] || "";
    inferred.street = clean(fullStreet.replace(/\s+(?:#|APT\.?|UNIT)\s*[A-Z0-9-]+$/, ""));
  }
  const cityStateZip = upper.match(/\b([A-Z][A-Z .'-]{2,35})[,]?\s+([A-Z]{2})\s+(\d{5}(?:-\d{4})?)\b/);
  if (cityStateZip) {
    inferred.city = clean(cityStateZip[1].replace(/^.*\d\s+/, ""));
    inferred.state = cityStateZip[2];
    inferred.zip = cityStateZip[3];
  }

  const vinLineIndex = inferred.vin ? upperLines.findIndex((line) => line.includes(inferred.vin)) : -1;
  const registrationDescription = vinLineIndex >= 0
    ? withoutTableSeparators(upperLines[vinLineIndex]).match(/^([A-Z0-9]{2,8})\s+([A-Z]{1,4})\s+[A-HJ-NPR-Z0-9]{17}$/)
    : null;
  const registrationNumbers = vinLineIndex >= 0
    ? upperLines.slice(vinLineIndex + 1, vinLineIndex + 3)
      .map((line) => withoutTableSeparators(line).match(/^([0-9]{1,9})\s+([A-Z0-9]{1,2})\s+(\d{1,2})\s+([A-Z0-9]{3,10})\s+(?:JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)\b/))
      .find(Boolean)
    : null;

  inferred.bodyType = registrationDescription?.[1] || firstMatch(labelledValue(upper, ["BODY TYPE"]), /\b([A-Z/ -]{2,20})\b/);
  inferred.color = registrationDescription?.[2] || firstMatch(labelledValue(upper, ["COLOR", "CLR"]), /\b([A-Z]{1,12})\b/);
  inferred.odometer = firstMatch(upper, /(?:ODOMETER|MILEAGE)\s*(?:READING)?\s*[:|]?\s*([0-9,]{1,9})\b/).replace(/,/g, "");
  const labelledFuel = firstMatch(labelledValue(upper, ["FUEL TYPE", "FUEL"]), /\b([A-Z0-9]{1,15})\b/);
  const fuelCode = registrationNumbers?.[2] || labelledFuel;
  inferred.fuelType = FUEL_CODES.has(fuelCode) ? fuelCode : "";
  inferred.cylinders = registrationNumbers?.[3] || firstMatch(upper, /(?:CYLINDERS?|CYL)\s*[:|]?\s*(\d{1,2})\b/);
  inferred.seating = firstMatch(tableValueBeforeLabel(upperLines, "SEATS"), /\b(\d{1,2})\b/)
    || (registrationNumbers?.[1] ? String(Number(registrationNumbers[1])) : "")
    || firstMatch(upper, /(?:SEATS?|SEATING CAPACITY)\s*[:|]?\s*(\d{1,2})\b/);

  return inferred;
}

const REGISTRATION_FIELDS = ["plate", "year", "make", "vin", "bodyType", "color", "fuelType", "cylinders", "seating"];

export function reconcileOrganizedData(organized: CaseData, text: string): CaseData {
  const reconciled = { ...EMPTY_CASE_DATA, ...organized };
  const inferred = inferCaseData([text]);

  // Compact NY registration rows are regular enough to parse deterministically.
  // Prefer those values over an LLM interpretation of the same codes.
  for (const key of REGISTRATION_FIELDS) {
    if (inferred[key]) reconciled[key] = inferred[key];
  }

  // A NYS DMV client ID is nine digits. Vehicle document/control codes such as
  // JM028525 must never be promoted to the customer's driver-license field.
  const normalizedNysId = (reconciled.nysId || "").replace(/\D/g, "");
  reconciled.nysId = normalizedNysId.length === 9 ? normalizedNysId : inferred.nysId;

  const sourceName = inferred.fullName.includes(",") ? inferred.fullName : reconciled.fullName;
  reconciled.fullName = normalizeOrganizedCustomerName(sourceName);
  if (reconciled.fullName) reconciled.printedName = reconciled.fullName;

  return reconciled;
}

export function toPdfFields(data: CaseData): Record<string, string> {
  const values: Record<string, string> = {};
  for (const field of AUTOMATION_FIELDS) {
    if (field.fillMode === "manual") continue;
    const value = clean(data[field.key] || data[field.deriveFrom || ""] || "");
    if (!value) continue;
    if (field.fillMode === "dateParts") {
      const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (match) {
        values[field.pdfHandlers[0]] = match[2];
        values[field.pdfHandlers[1]] = match[3];
        values[field.pdfHandlers[2]] = match[1];
      }
    } else if (field.pdfHandlers[0]) {
      values[field.pdfHandlers[0]] = value;
    }
  }
  return values;
}
