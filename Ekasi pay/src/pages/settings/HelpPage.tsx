import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { KPCard, PageTransition } from '../../components/shared/UIComponents';
import {
  ArrowLeft,
  BookOpen,
  ChevronDown,
  MessageCircle,
  Phone,
  Mail } from
'lucide-react';
import { toast } from 'sonner';
import { faqs } from '../../data/faqs';

export const HelpPage = ({ navigate }: {navigate: (p: string) => void;}) => {
  const [openFaq, setOpenFaq] = useState<number | null>(0);
  const handleWhatsApp = () => {
    toast.info('Opening WhatsApp...');
    window.open(
      'https://wa.me/27800123456?text=Hi%20KasiPay%20Support',
      '_blank'
    );
  };
  const handleCall = () => {
    toast.info('Calling...');
    window.location.href = 'tel:0800123456';
  };
  const handleEmail = () => {
    toast.info('Opening email...');
    window.location.href = 'mailto:support@kasipay.co.za';
  };
  return (
    <PageTransition className="min-h-0 h-full bg-slate-50">
      <div className="bg-white px-6 pt-12 pb-4 shadow-sm z-10 shrink-0">
        <div className="flex items-center">
          <button
            onClick={() => navigate('more')}
            className="p-2 -ml-2 text-slate-500 hover:text-slate-900 transition-colors">
            
            <ArrowLeft className="w-6 h-6" />
          </button>
          <h2 className="text-xl font-bold ml-2 text-slate-900">
            Help & Support
          </h2>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-6 pb-8 space-y-8">
        {/* Contact Options */}
        <section>
          <h3 className="text-sm font-bold text-slate-500 mb-3 uppercase tracking-wider">
            Contact Us
          </h3>
          <div className="grid grid-cols-1 gap-3">
            <KPCard
              onClick={handleWhatsApp}
              className="p-4 flex items-center gap-4 active:bg-slate-50 cursor-pointer active:scale-95 transition-transform">
              
              <div className="w-10 h-10 rounded-full bg-emerald-100 text-emerald-600 flex items-center justify-center shrink-0">
                <MessageCircle className="w-5 h-5" />
              </div>
              <div>
                <p className="font-bold text-slate-900">WhatsApp Support</p>
                <p className="text-sm text-slate-500">
                  Usually replies in 5 mins
                </p>
              </div>
            </KPCard>
            <KPCard
              onClick={handleCall}
              className="p-4 flex items-center gap-4 active:bg-slate-50 cursor-pointer active:scale-95 transition-transform">
              
              <div className="w-10 h-10 rounded-full bg-blue-100 text-blue-600 flex items-center justify-center shrink-0">
                <Phone className="w-5 h-5" />
              </div>
              <div>
                <p className="font-bold text-slate-900">Call Center</p>
                <p className="text-sm text-slate-500">
                  0800 123 456 (Toll Free)
                </p>
              </div>
            </KPCard>
            <KPCard
              onClick={handleEmail}
              className="p-4 flex items-center gap-4 active:bg-slate-50 cursor-pointer active:scale-95 transition-transform">
              
              <div className="w-10 h-10 rounded-full bg-amber-100 text-amber-600 flex items-center justify-center shrink-0">
                <Mail className="w-5 h-5" />
              </div>
              <div>
                <p className="font-bold text-slate-900">Email Us</p>
                <p className="text-sm text-slate-500">support@kasipay.co.za</p>
              </div>
            </KPCard>
          </div>
        </section>

        {/* FAQs */}
        <section>
          <h3 className="text-sm font-bold text-slate-500 mb-3 uppercase tracking-wider">
            Frequently Asked Questions
          </h3>
          <div className="space-y-3">
            {faqs.map((faq, i) =>
            <KPCard key={i} className="p-0 overflow-hidden">
                <button
                onClick={() => setOpenFaq(openFaq === i ? null : i)}
                className="w-full p-4 flex items-center justify-between text-left bg-white">
                
                  <span className="font-medium text-slate-900 pr-4">
                    {faq.q}
                  </span>
                  <ChevronDown
                  className={`w-5 h-5 text-slate-400 shrink-0 transition-transform duration-300 ${openFaq === i ? 'rotate-180' : ''}`} />
                
                </button>
                <AnimatePresence>
                  {openFaq === i &&
                <motion.div
                  initial={{
                    height: 0,
                    opacity: 0
                  }}
                  animate={{
                    height: 'auto',
                    opacity: 1
                  }}
                  exit={{
                    height: 0,
                    opacity: 0
                  }}
                  transition={{
                    duration: 0.2
                  }}>
                  
                      <div className="p-4 pt-0 text-sm text-slate-600 border-t border-slate-50 bg-slate-50/50">
                        {faq.a}
                      </div>
                    </motion.div>
                }
                </AnimatePresence>
              </KPCard>
            )}
          </div>
        </section>

        {/* Field pilot quick guide (replaces placeholder video tiles). */}
        <section>
          <h3 className="text-sm font-bold text-slate-500 mb-3 uppercase tracking-wider flex items-center gap-2">
            <BookOpen className="w-4 h-4" />
            Field pilot — quick steps
          </h3>
          <KPCard className="p-5 space-y-3 text-sm text-slate-700 leading-relaxed">
            <p>
              <strong className="text-slate-900">POS sale:</strong> Open{' '}
              <em className="not-italic text-emerald-700">Shop</em>, tap products,
              then checkout — cash or customer wallet (capture their phone when
              needed).
            </p>
            <p>
              <strong className="text-slate-900">Stock in:</strong>{' '}
              <em className="not-italic text-emerald-700">Inventory</em> →{' '}
              <strong>Scan</strong> bumps stock when the barcode already exists,
              otherwise opens Add stock with the barcode filled.
            </p>
            <p>
              <strong className="text-slate-900">Cash Send:</strong>{' '}
              <em className="not-italic text-emerald-700">Services</em> → capture
              KYC honestly; beneficiary ID must match the document scanned at payout.
              Use the camera scanner icon or a USB wedge pointed at ID barcodes.
            </p>
            <p>
              <strong className="text-slate-900">Scanner tips:</strong> add light,
              hold steady ~20–40 cm away; if the camera fails, plug in a retail USB
              scanner and focus the text field — digits type in automatically.
            </p>
            <p>
              <strong className="text-slate-900">When something breaks:</strong>{' '}
              <em className="not-italic text-emerald-700">Account Settings</em> →
              Diagnostics → Copy log text and send it with the time-of-issue to your
              pilot coordinator.
            </p>
          </KPCard>
        </section>

        <div className="text-center pt-8 pb-4">
          <p className="text-xs text-slate-400 font-medium">
            KasiPay Spaza App v2.1.0
          </p>
          <p className="text-xs text-slate-400">© 2026 KasiPay Network</p>
        </div>
      </div>
    </PageTransition>);

};