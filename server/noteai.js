const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');

const NOTES_DIR = path.join(__dirname, '../public/noteai-notes');
const DEFAULT_RETENTION_DAYS = Number(process.env.NOTEAI_RETENTION_DAYS || 7);

function ensureNotesDir() {
    if (!fs.existsSync(NOTES_DIR)) {
        fs.mkdirSync(NOTES_DIR, { recursive: true });
    }
}

async function cleanupOldNotes(maxAgeDays = DEFAULT_RETENTION_DAYS) {
    ensureNotesDir();
    if (!Number.isFinite(maxAgeDays) || maxAgeDays <= 0) return;
    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
    const files = await fs.promises.readdir(NOTES_DIR).catch(() => []);
    await Promise.all(files.map(async (file) => {
        if (!file.endsWith('.pdf')) return;
        const abs = path.join(NOTES_DIR, file);
        try {
            const stat = await fs.promises.stat(abs);
            if (stat.mtimeMs < cutoff) {
                await fs.promises.unlink(abs);
            }
        } catch (_e) {}
    }));
}

function formatRange(startedAt, endedAt) {
    const start = startedAt ? new Date(startedAt) : null;
    const end = endedAt ? new Date(endedAt) : null;
    if (!start || Number.isNaN(start.getTime())) return null;
    if (!end || Number.isNaN(end.getTime())) return start.toISOString();
    return `${start.toISOString()} to ${end.toISOString()}`;
}

async function transcribeAudio(filePath) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
        throw new Error('NoteAI is unavailable: OPENAI_API_KEY is not configured.');
    }
    const buffer = await fs.promises.readFile(filePath);
    const blob = new Blob([buffer], { type: 'audio/webm' });
    const form = new FormData();
    form.append('file', blob, path.basename(filePath));
    form.append('model', process.env.NOTEAI_TRANSCRIBE_MODEL || 'whisper-1');
    form.append('response_format', 'text');

    const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${apiKey}`
        },
        body: form
    });
    if (!response.ok) {
        const err = await response.text();
        throw new Error(`Transcription failed: ${err}`);
    }
    return (await response.text()).trim();
}

function summarizeFromChatNotes(chatNotes = []) {
    const rawRows = Array.isArray(chatNotes) ? chatNotes : [];
    const normalizedRows = rawRows
        .map((item) => {
            const role = item?.role === 'you' ? 'You' : 'Stranger';
            const text = String(item?.text || '').replace(/\s+/g, ' ').trim();
            return { role, text };
        })
        .filter((row) => row.text.length > 0)
        .slice(-60);

    const transcriptRows = normalizedRows.map((row) => `${row.role}: ${row.text}`);
    const transcript = transcriptRows.join('\n');

    const decisionRe = /\b(decided|decision|agree|agreed|confirmed|final|approved)\b/i;
    const actionRe = /\b(todo|action|follow up|next step|will|should|deadline|assign|assigned|owner|by\s+\w+)\b/i;
    const questionRe = /\?$/;

    const decisions = [];
    const actionItems = [];
    const keyPoints = [];
    const highlights = [];
    let youCount = 0;
    let strangerCount = 0;

    normalizedRows.forEach((row) => {
        const line = `${row.role}: ${row.text}`;
        if (row.role === 'You') youCount += 1;
        if (row.role === 'Stranger') strangerCount += 1;
        if (decisionRe.test(row.text) && decisions.length < 8) decisions.push(line);
        if (actionRe.test(row.text) && actionItems.length < 10) actionItems.push(line);
        if (!questionRe.test(row.text) && keyPoints.length < 12) keyPoints.push(line);
    });

    // Keep highlights focused on the latest meaningful lines.
    for (let i = normalizedRows.length - 1; i >= 0 && highlights.length < 6; i -= 1) {
        const row = normalizedRows[i];
        const line = `${row.role}: ${row.text}`;
        if (line.length > 20) highlights.unshift(line);
    }

    const usedForKey = new Set(keyPoints);
    decisions.forEach((line) => {
        if (!usedForKey.has(line) && keyPoints.length < 12) {
            keyPoints.push(line);
            usedForKey.add(line);
        }
    });

    return {
        transcript,
        summary: {
            title: 'Meeting Notes (Local Summary)',
            overview: normalizedRows.length
                ? `Generated locally from ${normalizedRows.length} recent chat lines (You: ${youCount}, Stranger: ${strangerCount}).`
                : 'Generated without external API. No chat lines were available; audio transcription is unavailable in local mode.',
            keyPoints: keyPoints.length ? keyPoints : transcriptRows.slice(0, 10),
            actionItems: actionItems.length ? actionItems : ['No explicit action items detected in local mode.'],
            importantHighlights: highlights
        }
    };
}

async function summarizeTranscript(transcript) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
        throw new Error('NoteAI is unavailable: OPENAI_API_KEY is not configured.');
    }
    const model = process.env.NOTEAI_SUMMARY_MODEL || 'gpt-4o-mini';
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify({
            model,
            temperature: 0.2,
            messages: [
                {
                    role: 'system',
                    content: 'You summarize meeting transcripts. Return strict JSON with keys: title, overview, keyPoints (array of strings), actionItems (array of strings), importantHighlights (array of strings).'
                },
                {
                    role: 'user',
                    content: transcript
                }
            ]
        })
    });
    if (!response.ok) {
        const err = await response.text();
        throw new Error(`Summarization failed: ${err}`);
    }
    const data = await response.json();
    const raw = data?.choices?.[0]?.message?.content || '';
    try {
        const parsed = JSON.parse(raw);
        return {
            title: parsed.title || 'Meeting Notes',
            overview: parsed.overview || '',
            keyPoints: Array.isArray(parsed.keyPoints) ? parsed.keyPoints : [],
            actionItems: Array.isArray(parsed.actionItems) ? parsed.actionItems : [],
            importantHighlights: Array.isArray(parsed.importantHighlights) ? parsed.importantHighlights : []
        };
    } catch (_e) {
        return {
            title: 'Meeting Notes',
            overview: raw.slice(0, 900),
            keyPoints: [],
            actionItems: [],
            importantHighlights: []
        };
    }
}

function writeList(doc, title, items) {
    doc.moveDown(0.5).fontSize(13).fillColor('#1f2937').text(title, { underline: false });
    if (!items || !items.length) {
        doc.fontSize(11).fillColor('#4b5563').text('- None');
        return;
    }
    items.forEach((item) => {
        doc.fontSize(11).fillColor('#111827').text(`- ${item}`);
    });
}

function writeHighlightCards(doc, highlights = []) {
    if (!highlights.length) return;
    doc.moveDown(0.6).fontSize(13).fillColor('#1f2937').text('Top Highlights');
    highlights.slice(0, 5).forEach((item, index) => {
        const y = doc.y + 6;
        const cardHeight = 34;
        doc.roundedRect(42, y, 510, cardHeight, 8).fill(index === 0 ? '#fde68a' : '#e2e8f0');
        doc.fillColor('#111827').fontSize(10).text(`H${index + 1}`, 52, y + 12);
        doc.fillColor('#0f172a').fontSize(10).text(String(item), 84, y + 9, { width: 455, ellipsis: true });
        doc.y = y + cardHeight + 2;
    });
}

async function createNotesPdf({ roomId, summary, transcript, metadata = {} }) {
    ensureNotesDir();
    await cleanupOldNotes();
    const fileName = `noteai-${roomId}-${Date.now()}.pdf`;
    const absolutePath = path.join(NOTES_DIR, fileName);
    const meetingRange = formatRange(metadata.startedAt, metadata.endedAt);

    await new Promise((resolve, reject) => {
        const doc = new PDFDocument({ margin: 42 });
        const stream = fs.createWriteStream(absolutePath);
        doc.pipe(stream);

        doc.rect(30, 28, 552, 84).fill('#eef2ff');
        doc.fillColor('#1f2937').fontSize(20).text(summary.title || 'Meeting Notes', 42, 44);
        doc.fillColor('#475569').fontSize(10).text(`Generated at: ${new Date().toISOString()}`, 42, 72);
        if (meetingRange) {
            doc.fillColor('#334155').fontSize(10).text(`Meeting range: ${meetingRange}`, 42, 88, { width: 500 });
        }
        doc.moveDown(3);

        doc.fontSize(14).fillColor('#1f2937').text('Overview');
        doc.moveDown(0.2);
        doc.fontSize(11).fillColor('#111827').text(summary.overview || 'No overview available.', {
            lineGap: 2
        });

        const keyCount = Array.isArray(summary.keyPoints) ? summary.keyPoints.length : 0;
        const actionCount = Array.isArray(summary.actionItems) ? summary.actionItems.length : 0;
        const highlightCount = Array.isArray(summary.importantHighlights) ? summary.importantHighlights.length : 0;
        doc.moveDown(0.6);
        doc.roundedRect(42, doc.y, 510, 42, 8).fill('#ecfeff');
        doc.fillColor('#0f172a').fontSize(11).text(
            `Snapshot: ${highlightCount} highlights | ${keyCount} key points | ${actionCount} action items`,
            54,
            doc.y + 13
        );
        doc.moveDown(2.2);

        writeHighlightCards(doc, summary.importantHighlights || []);

        writeList(doc, 'Important Highlights', summary.importantHighlights || []);
        writeList(doc, 'Key Points', summary.keyPoints || []);
        writeList(doc, 'Action Items', summary.actionItems || []);

        doc.addPage();
        doc.fontSize(14).fillColor('#111827').text('Transcript');
        doc.moveDown(0.5);
        doc.fontSize(10).fillColor('#1f2937').text(transcript || 'No transcript available.', {
            width: 520,
            align: 'left'
        });

        doc.end();
        stream.on('finish', resolve);
        stream.on('error', reject);
    });

    return {
        fileName,
        absolutePath,
        downloadUrl: `/noteai-notes/${fileName}`
    };
}

async function generateNoteAiPdf({ filePath, roomId, chatNotes = [], metadata = {} }) {
    const hasApiKey = Boolean(process.env.OPENAI_API_KEY);
    let transcript = '';
    let summary = null;

    if (hasApiKey) {
        transcript = await transcribeAudio(filePath);
        if (!transcript) {
            throw new Error('Transcription returned no text.');
        }
        summary = await summarizeTranscript(transcript);
    } else {
        const local = summarizeFromChatNotes(chatNotes);
        transcript = local.transcript || 'No transcript available in local mode.';
        summary = local.summary;
    }

    const pdf = await createNotesPdf({ roomId, summary, transcript, metadata });
    return {
        transcript,
        summary,
        ...pdf
    };
}

module.exports = { generateNoteAiPdf, ensureNotesDir, cleanupOldNotes };
