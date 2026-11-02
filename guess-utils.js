// Normalize submitted snowfall to the official one-decimal-place guess.
function parseOfficialGuess(rawGuess) {
  if (rawGuess == null) return null;
  const parsed = typeof rawGuess === 'number'
    ? rawGuess
    : parseFloat(String(rawGuess).replace(/[^0-9.\-]/g, ''));
  if (!Number.isFinite(parsed)) return null;

  // Shift the decimal before rounding to avoid binary errors at .05 boundaries.
  const [coefficient, exponent = '0'] = String(parsed).split('e');
  const shifted = Number(`${coefficient}e${Number(exponent) + 1}`);
  return Math.round(shifted) / 10;
}
