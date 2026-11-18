import { z } from "zod";

const controlCharacters = /[\u0000-\u001f\u007f-\u009f]/;
const multilineControlCharacters = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;

export function textInput(maxLength: number, maxLengthMessage = `Must be ${maxLength} characters or fewer`) {
  return z.string()
    .refine((value) => !controlCharacters.test(value), "Control characters are not allowed")
    .trim()
    .max(maxLength, maxLengthMessage);
}

export function multilineTextInput(maxLength: number, maxLengthMessage = `Must be ${maxLength} characters or fewer`) {
  return z.string()
    .refine((value) => !multilineControlCharacters.test(value), "Control characters are not allowed")
    .trim()
    .max(maxLength, maxLengthMessage);
}

export function passwordInput(minimumLength = 12) {
  return z.string()
    .min(minimumLength, minimumLength === 12 ? "Password must be at least 12 characters" : "Current password is required")
    .max(128, "Password must be 128 characters or fewer")
    .refine((value) => !controlCharacters.test(value), "Password must not contain control characters");
}
