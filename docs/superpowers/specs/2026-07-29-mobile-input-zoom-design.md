# Mobile Input Zoom Prevention Design

## Goal

Prevent iOS Safari from enlarging the page when a user focuses a form control and opens the keyboard.

## Cause

iOS Safari automatically zooms focused editable controls whose computed font size is below 16px. The application currently lets controls inherit surrounding font sizes, which can fall below that threshold.

## Design

Add one mobile-only stylesheet rule targeting `input`, `select`, and `textarea`. It sets their font size to 16px when the viewport is 600px wide or narrower.

The rule is scoped to form controls, so existing labels, helper text, badges, and desktop typography remain unchanged. It does not use `maximum-scale`, `user-scalable=no`, or JavaScript viewport manipulation; users retain browser zoom controls and the solution addresses the actual Safari trigger.

## Verification

Add a stylesheet contract test that checks the mobile media query contains the three editable control selectors and the `16px` font size. Run that targeted test, then run the web stylesheet test suite.
