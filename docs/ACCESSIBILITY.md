# Accessibility

WirePulse does **not** claim conformance with WCAG 2.1 level AA, Section 508, or EN 301 549. This page describes the automated accessibility coverage included in the public source and the review still required before making any conformance statement.

## Automated coverage

`e2e/accessibility.spec.ts` is part of `npm run test:e2e`. It runs the open-source [axe-core](https://github.com/dequelabs/axe-core) engine in Chromium on these console states:

- before a device is connected, with **Configure** open, and with macros in edit mode;
- connected, with log lines and telemetry on screen;
- a browser without Web Serial, showing its explanation;
- enterprise-console tabs with representative data.

The suite fails when axe reports a violation. Run it on the exact public-source revision and browser environment you intend to ship; automated results are only one input to accessibility review.

## Review still required

- **No manual audit.** Automated tools cover only part of the WCAG success criteria; meaningful reading order, instructions that do not rely on colour or shape, error handling, and time limits need a person.
- **No screen-reader testing** (NVDA, JAWS, VoiceOver, TalkBack), speech-input testing, or testing at 200% and 400% browser zoom or with Windows high-contrast mode.
- **No VPAT or Accessibility Conformance Report.** None should be quoted until a qualified reviewer completes an audit.
- **Responsive use needs validation.** WirePulse is a bench tool for a desktop browser with Web Serial; validate any narrow-screen requirements with the exact device and browser you support.
- **Coverage is selective.** A state reached only by an unusual action may not be represented in the automated suite.

## Running it yourself

```sh
npm run dev                                     # or any origin named by WP_E2E_ORIGIN
npx playwright test e2e/accessibility.spec.ts
```

The test uses fixed responses for the enterprise console. If you find a problem, report the screen, browser, and any assistive technology in use.
