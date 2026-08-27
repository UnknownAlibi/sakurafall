function normalizeTitle(value) {
    return String(value || '')
        .normalize('NFKC')
        .toLowerCase()
        .replace(/(?:\[|\()[^)\]]{0,48}(?:1080|720|2160|4k|bd|blu-?ray|web-?dl|hevc|h\.?265)[^)\]]{0,48}(?:]|\))/gi, '')
        .replace(/(?:\u66f4\u65b0\u81f3|\u66f4\u65b0\u5230|\u66f4\u81f3|\u7b2c)?\s*\d+\s*(?:\u96c6|\u8bdd)(?:\u5b8c|\u5168)?$/g, '')
        .replace(/\b(?:1080p?|720p?|2160p?|4k|bd|blu-?ray|web-?dl|hevc|h\.?265)\b/gi, '')
        .replace(/(?:\u5168\u96c6|\u5df2\u5b8c\u7ed3|\u5b8c\u7ed3)$/g, '')
        .replace(/[^\p{L}\p{N}]+/gu, '');
}

function levenshtein(a, b) {
    if (!a) return b.length;
    if (!b) return a.length;

    const row = Array.from({ length: b.length + 1 }, (_, index) => index);
    for (let i = 1; i <= a.length; i += 1) {
        let diagonal = row[0];
        row[0] = i;
        for (let j = 1; j <= b.length; j += 1) {
            const previous = row[j];
            row[j] = Math.min(
                row[j] + 1,
                row[j - 1] + 1,
                diagonal + (a[i - 1] === b[j - 1] ? 0 : 1)
            );
            diagonal = previous;
        }
    }
    return row[b.length];
}

function scoreTitleMatch(query, candidateTitle) {
    const expected = normalizeTitle(query);
    const actual = normalizeTitle(candidateTitle);
    if (!expected || !actual) {
        return { score: 0, reliable: false, exact: false };
    }
    if (expected === actual) {
        return { score: 1, reliable: true, exact: true };
    }

    const shorterLength = Math.min(expected.length, actual.length);
    const longerLength = Math.max(expected.length, actual.length);
    const containmentScore = expected.includes(actual) || actual.includes(expected)
        ? shorterLength / longerLength
        : 0;
    const editScore = 1 - (levenshtein(expected, actual) / longerLength);
    const score = Math.max(containmentScore, editScore);
    return {
        score,
        reliable: score >= 0.82 || (containmentScore >= 0.72 && shorterLength >= 4),
        exact: false
    };
}

module.exports = {
    normalizeTitle,
    scoreTitleMatch
};
