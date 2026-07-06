import { useCallback, useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { toast } from 'sonner';
import {
  KPCard,
  PageTransition,
  KPBadge } from
'../../components/shared/UIComponents';
import {
  ArrowLeft,
  Mic,
  MicOff,
  Trash2,
  Square,
} from
'lucide-react';
import type { VoiceNote } from '../../types';

/** Minimal subset of the Web Speech API surface we actually use. */
type SpeechRecognitionResultRow = {
  isFinal: boolean;
  0: { transcript: string };
};
type SpeechRecognitionLike = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((event: { results: SpeechRecognitionResultRow[] }) => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
};

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

const getSpeechRecognitionCtor = (): SpeechRecognitionCtor | null => {
  if (typeof window === 'undefined') return null;
  const w = window as Window & {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
};

/**
 * Guess a category from the captured transcript. Mirrors the old fake-data
 * heuristic so existing analytics labels still make sense.
 */
const guessCategory = (
  transcript: string,
): 'reminder' | 'debt' | 'order' | 'general' => {
  const lower = transcript.toLowerCase();
  if (/owes|debt|pay back|installment|credit/.test(lower)) return 'debt';
  if (/order|supplier|crate|stock|deliver/.test(lower)) return 'order';
  if (/remember|reminder|tomorrow|check|don.?t forget/.test(lower)) return 'reminder';
  return 'general';
};
export const VoiceNotesPage = ({
  notes,
  onAddNote,
  onDeleteNote,
  navigate





}: {notes: VoiceNote[];onAddNote: (note: Omit<VoiceNote, 'id' | 'merchantId' | 'createdAt'>) => void;onDeleteNote: (id: string) => void;navigate: (p: string) => void;}) => {
  const [isRecording, setIsRecording] = useState(false);
  const [recordingDuration, setRecordingDuration] = useState(0);
  const [interimTranscript, setInterimTranscript] = useState('');
  const [hasMic, setHasMic] = useState(true);
  const [activeCategory, setActiveCategory] = useState<
    'all' | 'reminder' | 'debt' | 'order' | 'general'>(
    'all');
  const categoryOptions: Array<'all' | 'reminder' | 'debt' | 'order' | 'general'> = [
    'all',
    'reminder',
    'debt',
    'order',
    'general'
  ];

  /** Audio recorder + SpeechRecognition refs persist across renders so we can stop them. */
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const transcriptRef = useRef('');
  const startTimeRef = useRef<number>(0);

  // Timer for recording
  useEffect(() => {
    let interval: ReturnType<typeof setInterval> | undefined;
    if (isRecording) {
      interval = setInterval(() => {
        setRecordingDuration((prev) => prev + 1);
      }, 1000);
    } else {
      setRecordingDuration(0);
    }
    return () => {
      if (interval) clearInterval(interval);
    };
  }, [isRecording]);

  useEffect(() => () => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    try {
      recognitionRef.current?.stop();
    } catch {
      /* recognizer already stopped */
    }
  }, []);

  const formatDuration = (seconds: number) => {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  const stopRecognition = useCallback(() => {
    const r = recognitionRef.current;
    if (!r) return;
    try {
      r.stop();
    } catch {
      /* already stopped */
    }
    recognitionRef.current = null;
  }, []);

  const stopRecording = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    const rec = recorderRef.current;
    if (rec && rec.state !== 'inactive') {
      try {
        rec.stop();
      } catch {
        /* already stopped */
      }
    }
    recorderRef.current = null;
  }, []);

  const finalizeAndSave = useCallback(() => {
    const duration = Math.max(
      1,
      Math.round((Date.now() - startTimeRef.current) / 1000),
    );
    const transcript =
      transcriptRef.current.trim() ||
      '(No transcript available — speech recognition was not supported on this device.)';
    const category = guessCategory(transcript);
    onAddNote({
      title: `Voice Note ${notes.length + 1}`,
      transcript,
      duration,
      category,
    });
    transcriptRef.current = '';
    setInterimTranscript('');
  }, [notes.length, onAddNote]);

  const startRecording = useCallback(async () => {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices) {
      setHasMic(false);
      toast.error('Microphone is not available on this device.');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      // We don't keep the audio blob today (no upload path yet) — but we run
      // MediaRecorder so the browser surface mirrors a real recording and
      // permissions get exercised properly.
      const rec = new MediaRecorder(stream);
      rec.start();
      recorderRef.current = rec;
      startTimeRef.current = Date.now();
      transcriptRef.current = '';
      setInterimTranscript('');

      const Ctor = getSpeechRecognitionCtor();
      if (Ctor) {
        const r = new Ctor();
        r.lang = navigator.language || 'en-ZA';
        r.interimResults = true;
        r.continuous = true;
        r.onresult = (event) => {
          let interim = '';
          for (const res of event.results) {
            if (res.isFinal) {
              transcriptRef.current = `${transcriptRef.current} ${res[0].transcript}`.trim();
            } else {
              interim = `${interim} ${res[0].transcript}`;
            }
          }
          setInterimTranscript(interim.trim());
        };
        r.onerror = (event) => {
          if (event.error && event.error !== 'no-speech') {
            toast.message(`Speech recognition: ${event.error}`);
          }
        };
        r.onend = () => {
          /* Browser may end recognition between phrases — we restart if still recording */
          if (recorderRef.current && recorderRef.current.state === 'recording') {
            try {
              r.start();
            } catch {
              /* will fall through to stop */
            }
          }
        };
        try {
          r.start();
          recognitionRef.current = r;
        } catch {
          recognitionRef.current = null;
        }
      }
      setIsRecording(true);
    } catch (e) {
      setHasMic(false);
      const msg =
        e instanceof Error ? e.message : 'Could not access microphone';
      toast.error(msg);
    }
  }, []);

  const handleToggleRecord = useCallback(() => {
    if (isRecording) {
      stopRecognition();
      stopRecording();
      setIsRecording(false);
      finalizeAndSave();
    } else {
      void startRecording();
    }
  }, [
    finalizeAndSave,
    isRecording,
    startRecording,
    stopRecognition,
    stopRecording,
  ]);
  const filteredNotes = notes.filter(
    (n) => activeCategory === 'all' || n.category === activeCategory
  );
  const getCategoryBadge = (category: string) => {
    switch (category) {
      case 'reminder':
        return <KPBadge variant="info">Reminder</KPBadge>;
      case 'debt':
        return <KPBadge variant="warning">Debt</KPBadge>;
      case 'order':
        return <KPBadge variant="success">Order</KPBadge>;
      default:
        return <KPBadge variant="neutral">General</KPBadge>;
    }
  };
  const formatRelativeTime = (dateStr: string) => {
    const date = new Date(dateStr);
    const now = new Date();
    const diffInHours = Math.floor(
      (now.getTime() - date.getTime()) / (1000 * 60 * 60)
    );
    if (diffInHours < 1) return 'Just now';
    if (diffInHours < 24) return `${diffInHours} hours ago`;
    return `${Math.floor(diffInHours / 24)} days ago`;
  };
  return (
    <PageTransition className="min-h-0 h-full bg-slate-50">
      {/* Header */}
      <div className="bg-white px-6 pt-12 pb-4 shadow-sm z-20 shrink-0">
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center">
            <button
              onClick={() => navigate('more')}
              className="p-2 -ml-2 text-slate-500 hover:text-slate-900 transition-colors">
              
              <ArrowLeft className="w-6 h-6" />
            </button>
            <h2 className="text-xl font-bold ml-2 text-slate-900">
              Voice Notes
            </h2>
          </div>
          <div className="w-10 h-10 bg-teal-100 text-teal-600 rounded-full flex items-center justify-center">
            <Mic className="w-5 h-5" />
          </div>
        </div>

        {/* Categories */}
        <div className="flex overflow-x-auto pb-2 -mx-6 px-6 scrollbar-hide gap-2">
          {categoryOptions.map((cat) =>
          <button
            key={cat}
            onClick={() => setActiveCategory(cat)}
            className={`px-4 py-1.5 rounded-full text-sm font-medium whitespace-nowrap transition-colors ${activeCategory === cat ? 'bg-slate-800 text-white' : 'bg-slate-100 text-slate-600'}`}>
            
              {cat.charAt(0).toUpperCase() + cat.slice(1)}
            </button>
          )}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 min-h-0 overflow-y-auto relative pb-8">
        {/* Recording Area */}
        <div
          className={`p-6 transition-colors duration-500 ${isRecording ? 'bg-red-50' : 'bg-slate-50'}`}>
          
          <div className="flex flex-col items-center justify-center py-6">
            <div className="relative">
              {isRecording &&
              <motion.div
                animate={{
                  scale: [1, 1.5, 1],
                  opacity: [0.5, 0, 0.5]
                }}
                transition={{
                  duration: 1.5,
                  repeat: Infinity
                }}
                className="absolute inset-0 bg-red-400 rounded-full" />

              }
              <button
                onClick={handleToggleRecord}
                className={`relative z-10 w-20 h-20 rounded-full flex items-center justify-center shadow-lg transition-all duration-300 ${isRecording ? 'bg-red-500 text-white scale-110' : 'bg-slate-800 text-white hover:bg-slate-700'}`}>
                
                {isRecording ?
                <Square className="w-8 h-8 fill-current" /> :

                <Mic className="w-8 h-8" />
                }
              </button>
            </div>

            <div className="mt-6 text-center min-h-12 w-full max-w-sm">
              {isRecording ?
              <motion.div
                initial={{
                  opacity: 0
                }}
                animate={{
                  opacity: 1
                }}>
                
                  <p className="text-red-500 font-bold text-xl font-mono tracking-wider">
                    {formatDuration(recordingDuration)}
                  </p>
                  <p className="text-sm text-red-400 font-medium mt-1 animate-pulse">
                    Recording…
                  </p>
                  {interimTranscript ?
                    <p className="text-xs text-slate-600 mt-3 italic">
                      “{interimTranscript}”
                    </p>
                  : null}
                </motion.div> :

              <div className="text-slate-500 font-medium">
                  {hasMic ?
                    <p>Tap to record a business note</p>
                  :
                    <p className="text-amber-700">
                      Microphone unavailable — check permissions.
                    </p>
                  }
                </div>
              }
            </div>
          </div>
        </div>

        {/* Notes List */}
        <div className="px-6 pb-6 space-y-4">
          <AnimatePresence mode="popLayout">
            {filteredNotes.length === 0 ?
            <motion.div
              initial={{
                opacity: 0
              }}
              animate={{
                opacity: 1
              }}
              className="text-center py-12 text-slate-500">
              
                <MicOff className="w-12 h-12 mx-auto mb-3 text-slate-300" />
                <p>No voice notes found</p>
              </motion.div> :

            filteredNotes.map((note) =>
            <motion.div
              key={note.id}
              layout
              initial={{
                opacity: 0,
                y: 20
              }}
              animate={{
                opacity: 1,
                y: 0
              }}
              exit={{
                opacity: 0,
                scale: 0.95
              }}
              transition={{
                duration: 0.2
              }}>
              
                  <KPCard className="p-4">
                    <div className="flex justify-between items-start mb-3">
                      {getCategoryBadge(note.category)}
                      <div className="flex items-center gap-3">
                        <span className="text-xs text-slate-400 font-medium">
                          {formatRelativeTime(note.createdAt)}
                        </span>
                        <button
                      onClick={() => onDeleteNote(note.id)}
                      className="text-slate-300 hover:text-red-500 transition-colors">
                      
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </div>

                    <p className="text-slate-800 font-medium mb-3 leading-relaxed">
                      "{note.transcript}"
                    </p>

                    <p className="text-xs text-slate-500">
                      Duration: {formatDuration(note.duration)}
                    </p>
                  </KPCard>
                </motion.div>
            )
            }
          </AnimatePresence>
        </div>
      </div>
    </PageTransition>);

};