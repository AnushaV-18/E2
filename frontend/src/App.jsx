import { useEffect, useState } from "react";
import {
  AppBar,
  Toolbar,
  Typography,
  Container,
  Card,
  CardContent,
  Button,
  Box,
  Chip,
  IconButton,
  Badge,
  Snackbar,
  Alert,
  CircularProgress,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  TextField,
  Divider,
  MenuItem,
  FormControlLabel,
  Checkbox,
} from "@mui/material";
import ShoppingCartIcon from "@mui/icons-material/ShoppingCart";
import ShoppingBagIcon from "@mui/icons-material/ShoppingBag";
import axios from "axios";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:5000";
const NAVY = "#172554";

// Delivery areas known to the warehouse road map (region ids used by the E2 engine)
const AREAS = [
  { id: 4, name: "Hubballi area" },
  { id: 5, name: "Bengaluru area" },
];

function formatEta(min) {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h > 0 ? `${h}h ${m}m` : `${m} min`;
}

function loadSavedUser() {
  try {
    return JSON.parse(localStorage.getItem("ecart_auth"));
  } catch {
    return null;
  }
}

function App() {
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [cart, setCart] = useState({});
  const [auth, setAuth] = useState(loadSavedUser());
  const [authOpen, setAuthOpen] = useState(false);
  const [mode, setMode] = useState("login");
  const [form, setForm] = useState({ name: "", email: "", password: "" });
  const [toast, setToast] = useState({ open: false, text: "", type: "info" });
  const [ordering, setOrdering] = useState(false);
  const [regionId, setRegionId] = useState(4);
  const [plus, setPlus] = useState(false);
  const [ordersOpen, setOrdersOpen] = useState(false);
  const [myOrders, setMyOrders] = useState([]);

  const show = (text, type = "info") => setToast({ open: true, text, type });

  const fetchProducts = async () => {
    try {
      const res = await axios.get(`${API_URL}/api/products`);
      setProducts(res.data);
    } catch {
      show("Could not load products. Is the backend running?", "error");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchProducts();
  }, []);

  const cartItems = products
    .filter((p) => cart[p.product_id])
    .map((p) => ({ ...p, qty: cart[p.product_id] }));
  const cartCount = cartItems.reduce((sum, i) => sum + i.qty, 0);
  const cartTotal = cartItems.reduce((sum, i) => sum + i.qty * Number(i.price), 0);

  const changeQty = (product, delta) => {
    const current = cart[product.product_id] || 0;
    const next = current + delta;
    if (next > product.stock_quantity) {
      show("No more stock available for this product.", "warning");
      return;
    }
    setCart((c) => {
      const copy = { ...c };
      if (next <= 0) delete copy[product.product_id];
      else copy[product.product_id] = next;
      return copy;
    });
  };

  const handleAuth = async () => {
    try {
      if (mode === "register") {
        await axios.post(`${API_URL}/api/auth/register`, form);
      }
      const res = await axios.post(`${API_URL}/api/auth/login`, {
        email: form.email,
        password: form.password,
      });
      setAuth(res.data);
      try {
        localStorage.setItem("ecart_auth", JSON.stringify(res.data));
      } catch {
        /* ignore */
      }
      setAuthOpen(false);
      setForm({ name: "", email: "", password: "" });
      show(`Welcome, ${res.data.customer.name}!`, "success");
    } catch (err) {
      show(err.response?.data?.message || "Something went wrong.", "error");
    }
  };

  const logout = () => {
    setAuth(null);
    try {
      localStorage.removeItem("ecart_auth");
    } catch {
      /* ignore */
    }
    show("Logged out.", "info");
  };

  const openMyOrders = async () => {
    setOrdersOpen(true);
    try {
      const res = await axios.get(`${API_URL}/api/orders/mine`, {
        headers: { Authorization: `Bearer ${auth.token}` },
      });
      setMyOrders(res.data);
    } catch (err) {
      show(err.response?.data?.message || "Could not load your orders.", "error");
    }
  };

  const placeOrder = async () => {
    if (!auth) {
      setMode("login");
      setAuthOpen(true);
      return;
    }
    setOrdering(true);
    const summaries = [];
    try {
      for (const item of cartItems) {
        const res = await axios.post(
          `${API_URL}/api/orders`,
          {
            customer_id: auth.customer.customer_id,
            product_id: item.product_id,
            quantity: item.qty,
            region_id: regionId,
            tier: plus ? "PLUS" : "REGULAR",
          },
          { headers: { Authorization: `Bearer ${auth.token}` } }
        );
        const a = res.data.allocation;
        summaries.push(
          a
            ? `${item.product_name}: delivery in about ${formatEta(a.etaMin)} from ${a.parts.length} warehouse${a.parts.length > 1 ? "s" : ""}`
            : `${item.product_name}: order placed`
        );
      }
      setCart({});
      show(`Order placed! ${summaries.join(" | ")}`, "success");
    } catch (err) {
      show(err.response?.data?.message || "Order failed.", "error");
    } finally {
      setOrdering(false);
      fetchProducts();
    }
  };

  return (
    <Box sx={{ minHeight: "100vh", bgcolor: "#f5f7fb" }}>
      <AppBar position="static" sx={{ bgcolor: NAVY }}>
        <Toolbar>
          <ShoppingBagIcon sx={{ mr: 1, fontSize: 32 }} />
          <Typography variant="h5" sx={{ flexGrow: 1, fontWeight: "bold" }}>
            eCart
          </Typography>
          {auth ? (
            <>
              <Typography sx={{ mr: 2 }}>Hi, {auth.customer.name}</Typography>
              <Button color="inherit" onClick={openMyOrders}>
                My orders
              </Button>
              <Button color="inherit" onClick={logout}>
                Logout
              </Button>
            </>
          ) : (
            <Button
              color="inherit"
              onClick={() => {
                setMode("login");
                setAuthOpen(true);
              }}
            >
              Login / Register
            </Button>
          )}
          <IconButton color="inherit" aria-label="Shopping cart">
            <Badge badgeContent={cartCount} color="error">
              <ShoppingCartIcon />
            </Badge>
          </IconButton>
        </Toolbar>
      </AppBar>

      <Container maxWidth="lg" sx={{ py: 5 }}>
        <Typography variant="h4" sx={{ fontWeight: "bold", color: NAVY, mb: 3 }}>
          Products
        </Typography>

        {loading ? (
          <CircularProgress />
        ) : products.length === 0 ? (
          <Alert severity="warning">No products found. Did you run schema.sql?</Alert>
        ) : (
          <Box
            sx={{
              display: "grid",
              gap: 3,
              gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))",
            }}
          >
            {products.map((p) => (
              <Card key={p.product_id} sx={{ borderRadius: 3, boxShadow: 2 }}>
                <CardContent sx={{ p: 3 }}>
                  <Chip
                    label={p.stock_quantity > 0 ? `In stock: ${p.stock_quantity}` : "Out of stock"}
                    color={p.stock_quantity > 0 ? "success" : "error"}
                    size="small"
                    sx={{ mb: 2 }}
                  />
                  <Typography variant="h6" sx={{ fontWeight: "bold" }}>
                    {p.product_name}
                  </Typography>
                  <Typography color="text.secondary" sx={{ mb: 2, minHeight: 48 }}>
                    {p.description}
                  </Typography>
                  <Typography variant="h5" sx={{ fontWeight: "bold", color: NAVY, mb: 2 }}>
                    ₹{Number(p.price).toLocaleString("en-IN")}
                  </Typography>
                  <Button
                    variant="contained"
                    fullWidth
                    disabled={p.stock_quantity <= 0}
                    onClick={() => changeQty(p, 1)}
                    sx={{ bgcolor: NAVY, "&:hover": { bgcolor: "#1e40af" } }}
                  >
                    Add to cart
                  </Button>
                </CardContent>
              </Card>
            ))}
          </Box>
        )}

        <Button variant="outlined" onClick={fetchProducts} sx={{ mt: 3 }}>
          Refresh stock
        </Button>

        <Typography variant="h4" sx={{ fontWeight: "bold", color: NAVY, mt: 6, mb: 2 }}>
          Your cart
        </Typography>
        <Card sx={{ borderRadius: 3, maxWidth: 520 }}>
          <CardContent>
            {cartItems.length === 0 ? (
              <Typography color="text.secondary">
                Your cart is empty. Add a product above.
              </Typography>
            ) : (
              <>
                {cartItems.map((item) => (
                  <Box
                    key={item.product_id}
                    sx={{ display: "flex", alignItems: "center", py: 1 }}
                  >
                    <Typography sx={{ flexGrow: 1 }}>{item.product_name}</Typography>
                    <Button size="small" onClick={() => changeQty(item, -1)}>
                      −
                    </Button>
                    <Typography sx={{ mx: 1 }}>{item.qty}</Typography>
                    <Button size="small" onClick={() => changeQty(item, 1)}>
                      +
                    </Button>
                    <Typography sx={{ width: 90, textAlign: "right" }}>
                      ₹{(item.qty * Number(item.price)).toLocaleString("en-IN")}
                    </Typography>
                  </Box>
                ))}
                <Divider sx={{ my: 2 }} />
                <TextField
                  select
                  label="Deliver to"
                  size="small"
                  fullWidth
                  value={regionId}
                  onChange={(e) => setRegionId(Number(e.target.value))}
                  sx={{ mb: 1 }}
                >
                  {AREAS.map((a) => (
                    <MenuItem key={a.id} value={a.id}>
                      {a.name}
                    </MenuItem>
                  ))}
                </TextField>
                <FormControlLabel
                  control={<Checkbox checked={plus} onChange={(e) => setPlus(e.target.checked)} />}
                  label="Plus delivery (fastest warehouse)"
                />
                <Typography variant="h6" sx={{ my: 2 }}>
                  Total: ₹{cartTotal.toLocaleString("en-IN")}
                </Typography>
                <Button
                  variant="contained"
                  color="success"
                  fullWidth
                  disabled={ordering}
                  onClick={placeOrder}
                >
                  {auth ? (ordering ? "Placing order..." : "Place order") : "Log in to place order"}
                </Button>
              </>
            )}
          </CardContent>
        </Card>
      </Container>

      <Dialog open={ordersOpen} onClose={() => setOrdersOpen(false)} fullWidth maxWidth="sm">
        <DialogTitle>My orders</DialogTitle>
        <DialogContent>
          {myOrders.length === 0 ? (
            <Typography color="text.secondary">No orders yet.</Typography>
          ) : (
            myOrders.map((o) => (
              <Box key={o.order_id} sx={{ py: 1.5, borderBottom: "1px solid #e5e7eb" }}>
                <Typography sx={{ fontWeight: "bold" }}>
                  #{o.order_id} · {o.product_name} × {o.quantity}{" "}
                  <Chip size="small" label={o.status} sx={{ ml: 1 }} />
                  {o.order_type === "PLUS" && <Chip size="small" color="primary" label="PLUS" sx={{ ml: 1 }} />}
                </Typography>
                {o.shipments.map((sh) => (
                  <Typography key={sh.shipment_id} color="text.secondary" variant="body2">
                    {sh.warehouse_name}: {sh.status}
                  </Typography>
                ))}
              </Box>
            ))
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={openMyOrders}>Refresh</Button>
          <Button onClick={() => setOrdersOpen(false)}>Close</Button>
        </DialogActions>
      </Dialog>

      <Dialog open={authOpen} onClose={() => setAuthOpen(false)} fullWidth maxWidth="xs">
        <DialogTitle>{mode === "login" ? "Log in" : "Create account"}</DialogTitle>
        <DialogContent>
          {mode === "register" && (
            <TextField
              label="Name"
              fullWidth
              margin="dense"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          )}
          <TextField
            label="Email"
            type="email"
            fullWidth
            margin="dense"
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
          />
          <TextField
            label="Password"
            type="password"
            fullWidth
            margin="dense"
            value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })}
          />
          <Button
            size="small"
            sx={{ mt: 1 }}
            onClick={() => setMode(mode === "login" ? "register" : "login")}
          >
            {mode === "login" ? "New here? Create an account" : "Already registered? Log in"}
          </Button>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setAuthOpen(false)}>Cancel</Button>
          <Button variant="contained" onClick={handleAuth}>
            {mode === "login" ? "Log in" : "Register"}
          </Button>
        </DialogActions>
      </Dialog>

      <Snackbar
        open={toast.open}
        autoHideDuration={3500}
        onClose={() => setToast({ ...toast, open: false })}
        anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
      >
        <Alert severity={toast.type} variant="filled" onClose={() => setToast({ ...toast, open: false })}>
          {toast.text}
        </Alert>
      </Snackbar>
    </Box>
  );
}

export default App;