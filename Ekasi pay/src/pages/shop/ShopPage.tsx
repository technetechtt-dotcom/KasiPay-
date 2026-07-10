import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import {
  KPButton,
  KPCard,
  KPAmount,
  KPInput,
  PageTransition } from
'../../components/shared/UIComponents';
import {
  Package,
  Search,
  CreditCard,
  Banknote,
  CheckCircle2,
  MessageCircle,
  Minus,
  Plus,
} from 'lucide-react';
import { toast } from 'sonner';
import { openProductScanner, drainShopScanQueue } from '../../lib/scannerSession';
import { findProductByBarcode } from '../../lib/productBarcode';
import { FloatingScanButton } from '../../components/shared/FloatingScanButton';
import type { Product } from '../../types';

export const ShopPage = ({
  products,
  onMakeSale,
  navigate,
}: {
  products: Product[];
  onMakeSale: (
    items: { product: Product; quantity: number }[],
    method: 'cash' | 'wallet',
    phone?: string,
  ) => boolean | Promise<boolean>;
  navigate: (p: string) => void;
}) => {
  const [cart, setCart] = useState<{ product: Product; quantity: number }[]>([]);
  const [showCheckout, setShowCheckout] = useState(false);
  const [paymentMethod, setPaymentMethod] = useState<'cash' | 'wallet'>('cash');
  const [customerPhone, setCustomerPhone] = useState('');
  const [success, setSuccess] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<string>('All');
  const categories = [
    'All',
    ...Array.from(new Set(products.map((p) => p.category))),
  ];

  const addToCart = (product: Product) => {
    if (product.stock <= 0) {
      toast.error(`${product.name} is out of stock`);
      return;
    }
    setCart((prev) => {
      const existing = prev.find((item) => item.product.id === product.id);
      if (existing) {
        if (existing.quantity >= product.stock) return prev;
        return prev.map((item) =>
          item.product.id === product.id
            ? { ...item, quantity: item.quantity + 1 }
            : item,
        );
      }
      return [...prev, { product, quantity: 1 }];
    });
  };

  useEffect(() => {
    const processQueue = () => {
      const items = drainShopScanQueue();
      if (items.length === 0) return;
      for (const item of items) {
        if (item.productId) {
          const product = products.find((p) => p.id === item.productId);
          if (product) addToCart(product);
          continue;
        }
        if (item.barcode) {
          const product = findProductByBarcode(products, item.barcode);
          if (product) addToCart(product);
        }
      }
    };
    processQueue();
    const id = window.setInterval(processQueue, 400);
    return () => window.clearInterval(id);
  }, [products]);

  const removeFromCart = (productId: string) => {
    setCart((prev) => {
      const existing = prev.find((item) => item.product.id === productId);
      if (!existing) return prev;
      if (existing.quantity > 1) {
        return prev.map((item) =>
          item.product.id === productId
            ? { ...item, quantity: item.quantity - 1 }
            : item,
        );
      }
      if (prev.length === 1) {
        setShowCheckout(false);
      }
      return prev.filter((item) => item.product.id !== productId);
    });
  };
  const total = cart.reduce(
    (sum, item) => sum + item.product.price * item.quantity,
    0
  );
  const handleCheckout = () => {
    if (paymentMethod === 'wallet' && customerPhone.length < 10) return;
    void (async () => {
      const ok = await Promise.resolve(
        onMakeSale(cart, paymentMethod, customerPhone)
      );
      if (ok) {
        setSuccess(true);
        toast.success('Sale completed!');
      } else {
        toast.error('Sale failed. Check stock, wallet balance, or try again.');
      }
    })();
  };
  const handleShareReceipt = () => {
    const date = new Date().toLocaleString();
    const itemsList = cart
      .map(
        (i) =>
          `${i.quantity}x ${i.product.name} - R${(i.product.price * i.quantity).toFixed(2)}`,
      )
      .join('\n');
    const text = `*KasiPay Spaza Receipt*\n${date}\n\n*Items:*\n${itemsList}\n\n*Total: R${total.toFixed(2)}*\nPaid via: ${paymentMethod.toUpperCase()}\n\nThank you for your support!`;
    /**
     * Prefer the native share sheet so users can send to any chat app, email
     * or AirDrop without forcing WhatsApp. Falls back to a WhatsApp deep link
     * (and finally clipboard) on browsers/devices without share support.
     */
    const nav: Navigator & {
      share?: (data: ShareData) => Promise<void>;
    } = navigator;
    if (typeof nav.share === 'function') {
      nav
        .share({ title: 'KasiPay Receipt', text })
        .catch(() => {
          /* User cancelled — no toast */
        });
      return;
    }
    if (typeof navigator.clipboard?.writeText === 'function') {
      void navigator.clipboard
        .writeText(text)
        .then(() => toast.success('Receipt copied to clipboard'))
        .catch(() => {
          window.open(
            `https://wa.me/?text=${encodeURIComponent(text)}`,
            '_blank',
          );
        });
      return;
    }
    window.open(
      `https://wa.me/?text=${encodeURIComponent(text)}`,
      '_blank',
    );
  };
  if (success) {
    return (
      <PageTransition className="px-6 pt-12 flex flex-col items-center text-center h-full overflow-y-auto pb-8">
        <div className="w-20 h-20 bg-blue-100 rounded-full flex items-center justify-center mb-4 shrink-0">
          <CheckCircle2 className="w-10 h-10 text-blue-600" />
        </div>
        <h2 className="text-2xl font-bold text-slate-900 mb-2">
          Sale Complete
        </h2>
        <p className="text-slate-500 mb-6">
          Total: <KPAmount amount={total} />
        </p>

        {/* Receipt Card */}
        <KPCard className="w-full p-4 mb-8 text-left bg-slate-50 border-dashed border-2 border-slate-200">
          <div className="text-center border-b border-slate-200 pb-3 mb-3">
            <p className="font-bold text-slate-900">KasiPay Spaza</p>
            <p className="text-xs text-slate-500">
              {new Date().toLocaleString()}
            </p>
          </div>
          <div className="space-y-2 mb-3">
            {cart.map((item, i) =>
            <div key={i} className="flex justify-between text-sm">
                <span className="text-slate-600">
                  {item.quantity}x {item.product.name}
                </span>
                <span className="font-medium text-slate-900">
                  R{(item.product.price * item.quantity).toFixed(2)}
                </span>
              </div>
            )}
          </div>
          <div className="border-t border-slate-200 pt-3 flex justify-between items-center">
            <span className="font-bold text-slate-900">Total</span>
            <span className="font-bold text-lg text-slate-900">
              R{total.toFixed(2)}
            </span>
          </div>
          <div className="mt-2 text-xs text-slate-500 text-center uppercase tracking-wider">
            Paid via {paymentMethod}
          </div>
        </KPCard>

        <div className="w-full space-y-3 mt-auto">
          <KPButton
            onClick={handleShareReceipt}
            className="bg-[#25D366] hover:bg-[#128C7E] text-white border-none flex items-center justify-center gap-2">
            
            <MessageCircle className="w-5 h-5" />
            Share via WhatsApp
          </KPButton>
          <KPButton onClick={() => navigate('home')}>Back to Home</KPButton>
          <KPButton
            variant="outline"
            onClick={() => {
              setCart([]);
              setSuccess(false);
              setShowCheckout(false);
              setCustomerPhone('');
              setPaymentMethod('cash');
            }}>
            
            New Sale
          </KPButton>
        </div>
      </PageTransition>);

  }
  const quickItems = products.slice(0, 3);
  const filteredProducts = products.filter((p) => {
    const matchesSearch = p.name.
    toLowerCase().
    includes(searchQuery.toLowerCase());
    const matchesCategory =
    selectedCategory === 'All' || p.category === selectedCategory;
    return matchesSearch && matchesCategory;
  });
  return (
    <div className="flex flex-col min-h-0 h-full bg-slate-50">
      {/* Fixed Header */}
      <div className="bg-white px-6 pt-12 pb-4 shadow-sm z-10 shrink-0">
        <h2 className="text-xl font-bold text-slate-900 mb-4">Shop POS</h2>
        <div className="relative mb-4">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
          <input
            type="text"
            placeholder="Search products..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full bg-slate-100 rounded-xl py-2.5 pl-10 pr-4 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20" />
          
        </div>

        {/* Category Filter */}
        <div className="flex gap-2 overflow-x-auto pb-2 scrollbar-hide">
          {categories.map((category) =>
          <button
            key={category}
            onClick={() => setSelectedCategory(category)}
            className={`px-4 py-1.5 rounded-full text-sm font-medium whitespace-nowrap transition-colors ${selectedCategory === category ? 'bg-blue-600 text-white shadow-sm' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}>
            
              {category}
            </button>
          )}
        </div>
      </div>

      {/* Scrollable Product Area */}
      <div className="flex-1 min-h-0 overflow-y-auto p-6 pb-nav">
        {!searchQuery && selectedCategory === 'All' &&
        <>
            <h3 className="text-sm font-bold text-slate-500 mb-3 uppercase tracking-wider">
              Quick Add
            </h3>
            <div className="flex gap-3 mb-8 overflow-x-auto pb-2 scrollbar-hide">
              {quickItems.map((p) =>
            <button
              key={`quick-${p.id}`}
              onClick={() => addToCart(p)}
              className="bg-white border border-slate-200 rounded-xl p-3 min-w-[120px] text-left active:scale-95 transition-transform">
              
                  <p className="font-medium text-slate-900 text-sm truncate">
                    {p.name}
                  </p>
                  <KPAmount
                amount={p.price}
                className="text-blue-600 text-sm" />
              
                </button>
            )}
            </div>
          </>
        }

        <h3 className="text-sm font-bold text-slate-500 mb-3 uppercase tracking-wider">
          {searchQuery ? 'Search Results' : 'All Products'}
        </h3>
        {filteredProducts.length === 0 ?
        <div className="text-center py-12 text-slate-500">
            <Package className="w-12 h-12 mx-auto mb-3 text-slate-300" />
            <p>No products found</p>
          </div> :

        <div className="grid grid-cols-2 gap-4 pb-8">
            {filteredProducts.map((product) => {
            const inCart =
            cart.find((i) => i.product.id === product.id)?.quantity || 0;
            return (
              <KPCard
                key={product.id}
                className={`p-4 flex flex-col relative overflow-hidden ${product.stock === 0 ? 'opacity-50' : 'active:scale-95'}`}
                onClick={() => addToCart(product)}>
                
                  {inCart > 0 &&
                <div className="absolute top-0 right-0 bg-blue-500 text-white text-xs font-bold w-6 h-6 flex items-center justify-center rounded-bl-lg">
                      {inCart}
                    </div>
                }
                  <div className="w-10 h-10 bg-slate-100 rounded-lg flex items-center justify-center mb-3">
                    <Package className="w-5 h-5 text-slate-400" />
                  </div>
                  <p className="font-medium text-slate-900 text-sm leading-tight mb-1">
                    {product.name}
                  </p>
                  <div className="mt-auto flex justify-between items-end">
                    <KPAmount
                    amount={product.price}
                    className="text-slate-700 text-sm" />
                  
                    <span className="text-[10px] text-slate-400">
                      {product.stock} left
                    </span>
                  </div>
                </KPCard>);

          })}
          </div>
        }
      </div>

      {/* Cart Bar - always visible at bottom when items in cart */}
      {cart.length > 0 &&
      <motion.div
        initial={{
          y: 100
        }}
        animate={{
          y: 0
        }}
        className="shrink-0 bg-white border-t border-slate-200 rounded-t-3xl shadow-[0_-10px_40px_rgba(0,0,0,0.1)] z-50">
        
          {showCheckout ?
        <div className="p-6 max-h-[60vh] overflow-y-auto">
              <div className="flex justify-between items-center mb-6">
                <h3 className="text-lg font-bold">Checkout</h3>
                <button
              onClick={() => setShowCheckout(false)}
              className="text-slate-500">
              
                  Back
                </button>
              </div>

              <div className="bg-slate-50 rounded-xl p-4 mb-6">
                <p className="text-sm text-slate-500 mb-1">Total Amount</p>
                <div className="text-3xl font-bold text-slate-900">
                  <KPAmount amount={total} />
                </div>
              </div>

              <p className="font-medium text-slate-900 mb-3">Payment Method</p>
              <div className="grid grid-cols-2 gap-3 mb-6">
                <button
              onClick={() => setPaymentMethod('cash')}
              className={`p-4 rounded-xl border-2 flex flex-col items-center gap-2 transition-all ${paymentMethod === 'cash' ? 'border-blue-600 bg-blue-50 text-blue-700' : 'border-slate-200 text-slate-600'}`}>
              
                  <Banknote className="w-6 h-6" />
                  <span className="font-medium text-sm">Cash</span>
                </button>
                <button
              onClick={() => setPaymentMethod('wallet')}
              className={`p-4 rounded-xl border-2 flex flex-col items-center gap-2 transition-all ${paymentMethod === 'wallet' ? 'border-blue-600 bg-blue-50 text-blue-700' : 'border-slate-200 text-slate-600'}`}>
              
                  <CreditCard className="w-6 h-6" />
                  <span className="font-medium text-sm">Customer Wallet</span>
                </button>
              </div>

              {paymentMethod === 'wallet' &&
          <div className="mb-6">
                  <KPInput
              label="Customer Phone Number"
              placeholder="082 123 4567"
              value={customerPhone}
              onChange={(e) => setCustomerPhone(e.target.value)} />
            
                </div>
          }

              <div className="pt-4">
                <KPButton
              onClick={handleCheckout}
              disabled={
              paymentMethod === 'wallet' && customerPhone.length < 10
              }
              className="bg-blue-600 hover:bg-blue-700">
              
                  Complete Sale
                </KPButton>
              </div>
            </div> :

        <div className="p-6 max-h-[60vh] overflow-y-auto flex flex-col">
              <div className="flex justify-between items-center mb-4 shrink-0">
                <span className="font-medium text-slate-700">
                  {cart.reduce((sum, item) => sum + item.quantity, 0)} items
                </span>
                <span className="text-xl font-bold text-slate-900">
                  <KPAmount amount={total} />
                </span>
              </div>

              <div className="space-y-3 mb-6">
                {cart.map((item) =>
            <div
              key={item.product.id}
              className="flex items-center justify-between bg-slate-50 p-3 rounded-xl border border-slate-100">
              
                    <div className="flex-1 min-w-0 mr-3">
                      <p className="font-medium text-slate-900 text-sm truncate">
                        {item.product.name}
                      </p>
                      <KPAmount
                  amount={item.product.price * item.quantity}
                  className="text-blue-600 text-sm" />
                
                    </div>
                    <div className="flex items-center gap-3 bg-white rounded-lg border border-slate-200 p-1 shrink-0">
                      <button
                  onClick={() => removeFromCart(item.product.id)}
                  className="w-7 h-7 flex items-center justify-center text-slate-600 active:bg-slate-100 rounded-md transition-colors">
                  
                        <Minus className="w-4 h-4" />
                      </button>
                      <span className="font-medium text-sm w-4 text-center">
                        {item.quantity}
                      </span>
                      <button
                  onClick={() => addToCart(item.product)}
                  disabled={item.quantity >= item.product.stock}
                  className="w-7 h-7 flex items-center justify-center text-blue-600 active:bg-blue-50 disabled:opacity-50 rounded-md transition-colors">
                  
                        <Plus className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
            )}
              </div>

              <KPButton
            onClick={() => setShowCheckout(true)}
            className="bg-blue-600 hover:bg-blue-700 shrink-0">
            
                Proceed to Checkout
              </KPButton>
            </div>
        }
        </motion.div>
      }
      {!showCheckout && cart.length === 0 ?
      <FloatingScanButton
        accent="blue"
        label="Scan"
        className="z-50"
        onClick={() => openProductScanner(navigate, { returnPage: 'shop', stockMode: 'sale' })}
      />
      : null}
    </div>);

};