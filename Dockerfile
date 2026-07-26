# Stage 1: Build stage
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install all dependencies (including devDependencies for TypeScript compilation)
RUN npm ci

# Copy TypeScript config and source code
COPY tsconfig.json ./
COPY src ./src

# Compile TypeScript to ./dist
RUN npm run build

# Stage 2: Production runtime stage
FROM node:20-alpine AS runner

WORKDIR /app

# Set environment variables
ENV NODE_ENV=production
ENV PORT=10000

# Copy package files
COPY package*.json ./

# Install only production dependencies for a lightweight image
RUN npm ci --only=production && npm cache clean --force

# Copy compiled artifacts from builder stage
COPY --from=builder /app/dist ./dist

# Expose Render default web service port
EXPOSE 10000

# Run database migrations and boot the backend server
CMD ["sh", "-c", "node dist/database/migrate.js && node dist/index.js"]
